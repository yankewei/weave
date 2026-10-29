<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

/**
 * Project documents. Every write bumps the version and stores an immutable
 * revision and an audit event in the same transaction, so history is complete.
 */
final readonly class Documents
{
    private const MISSING = '文档不存在或无权访问。';
    private const MAX_BODY = 200_000;
    // A body of MAX_BODY characters, each up to 6 bytes once JSON-escaped, plus the other fields.
    public const MAX_REQUEST_BYTES = self::MAX_BODY * 6 + 4096;

    public function __construct(private PostgresConnectionPool $database, private Auth $auth)
    {
    }

    public function list(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $projectId = Workspaces::projectId($request);
        Workspaces::project($this->database, $projectId, $user['id']);

        return Json::response([...$this->database->execute(
            'SELECT ' . self::columns(body: false) . ' FROM documents d WHERE d.project_id = $1 ORDER BY d.updated_at DESC, d.id',
            [$projectId],
        )]);
    }

    public function create(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $projectId = Workspaces::projectId($request);
        $payload = self::payload($request, 'title', 'body');
        [$title, $body] = self::content($payload);
        $payload->check();

        return Json::response(Sql::transaction($this->database, function (PostgresExecutor $db) use ($projectId, $user, $title, $body): array {
            $workspaceId = Workspaces::project($db, $projectId, $user['id'], 'SHARE');

            return self::save(
                $db,
                'counter AS (
                   UPDATE workspaces SET document_counter = document_counter + 1 WHERE id = $1 RETURNING document_counter
                 ), d AS (
                   INSERT INTO documents(id, workspace_id, project_id, number, title, body, version, updated_by)
                   SELECT gen_random_uuid(), $1, $2, document_counter, $3, $4, 1, $5 FROM counter
                   RETURNING *
                 )',
                [$workspaceId, $projectId, $title, $body, $user['id']],
                $user['id'],
                'create',
                null,
                null,
            );
        }), 201);
    }

    public function read(Request $request): Response
    {
        $user = $this->auth->requireUser($request);

        return Json::response(self::document($this->database, self::id($request), $user['id']));
    }

    public function update(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $documentId = self::id($request);
        $payload = self::payload($request, 'baseVersion', 'title', 'body');
        $baseVersion = $payload->positiveInt('baseVersion');
        [$title, $body] = self::content($payload);
        $payload->check();

        return Json::response($this->change($documentId, $user['id'], $baseVersion, static fn (): array => [$title, $body, null]));
    }

    // Writes an earlier revision's title and body as a new version.
    public function restore(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $documentId = self::id($request);
        $payload = Input::json($request, 'baseVersion', 'revisionVersion');
        $baseVersion = $payload->positiveInt('baseVersion');
        $revisionVersion = $payload->positiveInt('revisionVersion');
        $payload->check();

        return Json::response($this->change($documentId, $user['id'], $baseVersion, static function (PostgresExecutor $db) use ($documentId, $revisionVersion): array {
            $revision = $db->execute(
                'SELECT title, body FROM document_revisions WHERE document_id = $1 AND version = $2',
                [$documentId, $revisionVersion],
            )->fetchRow() ?? throw new ApiError(404, '历史版本不存在。');

            return [Sql::string($revision, 'title'), Sql::string($revision, 'body'), $revisionVersion];
        }));
    }

    public function revisions(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        // Every document is created with its first revision, so no rows means no access.
        $revisions = [...$this->database->execute(
            'SELECT r.version, r.title, r.body, u.name AS "actorName", ' . Sql::iso('r.created_at') . ' AS "createdAt",
               r.operation_id AS "operationId", r.kind, r.restored_from_version AS "restoredFromVersion"
             FROM document_revisions r JOIN users u ON u.id = r.actor_id
             JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = $2
             WHERE r.document_id = $1 ORDER BY r.version DESC',
            [self::id($request), $user['id']],
        )];

        return $revisions === [] ? throw new ApiError(404, self::MISSING) : Json::response($revisions);
    }

    /**
     * Writes the title and body `$next` returns, as long as the document is
     * still at `$baseVersion`. Saving unchanged content is a no-op.
     *
     * @param \Closure(PostgresExecutor): array{string, string, ?int} $next Title, body, and the version restored from.
     * @return array<string, mixed>
     */
    private function change(string $documentId, string $userId, int $baseVersion, \Closure $next): array
    {
        return Sql::transaction($this->database, function (PostgresExecutor $db) use ($documentId, $userId, $baseVersion, $next): array {
            $current = self::document($db, $documentId, $userId, 'FOR UPDATE OF d FOR SHARE OF m');
            if ($current['version'] !== $baseVersion) {
                throw new ApiError(409, '文档已被修改。你的草稿已保留，请查看最新版本后再保存。');
            }
            [$title, $body, $restoredFrom] = $next($db);
            if ($title === $current['title'] && $body === $current['body']) {
                return $current;
            }

            return self::save(
                $db,
                'd AS (
                   UPDATE documents SET title = $1, body = $2, version = version + 1, updated_by = $3, updated_at = now()
                   WHERE id = $4 RETURNING *
                 )',
                [$title, $body, $userId, $documentId],
                $userId,
                $restoredFrom === null ? 'edit' : 'restore',
                $baseVersion,
                $restoredFrom,
            );
        });
    }

    /**
     * The document, or 404 unless the caller is a member of its workspace.
     * `$lock` is a row-locking clause over `d` and `m`.
     *
     * @return array<string, mixed>
     */
    private static function document(PostgresExecutor $db, string $documentId, string $userId, string $lock = ''): array
    {
        return $db->execute(
            'SELECT ' . self::columns() . ' FROM documents d
             JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = $2
             WHERE d.id = $1 ' . $lock,
            [$documentId, $userId],
        )->fetchRow() ?? throw new ApiError(404, self::MISSING);
    }

    /**
     * The only way a document version is written. `$write` is the CTEs ending in
     * `d`, the inserted or updated document row; its snapshot and the audit event
     * that points at it go in the same statement, so the body is sent only once.
     *
     * @param list<mixed> $params The parameters `$write` uses, numbered from $1.
     * @param 'create'|'edit'|'restore' $kind
     * @return array<string, mixed>
     */
    private static function save(PostgresExecutor $db, string $write, array $params, string $userId, string $kind, ?int $beforeVersion, ?int $restoredFrom): array
    {
        $next = count($params);
        [$actor, $kindParam, $restored, $before, $method] = array_map(static fn (int $i): string => '$' . ($next + $i), range(1, 5));

        return $db->execute(
            "WITH {$write}, r AS (
               INSERT INTO document_revisions(workspace_id, project_id, document_id, version, title, body, actor_id,
                 operation_id, kind, restored_from_version)
               SELECT workspace_id, project_id, id, version, title, body, {$actor}::uuid, gen_random_uuid(),
                 {$kindParam}::text, {$restored}::int FROM d
               RETURNING operation_id, workspace_id, project_id, document_id, version
             ), a AS (
               INSERT INTO audit_events(operation_id, workspace_id, project_id, document_id, before_version, after_version,
                 initiator_id, confirmer_id, method)
               SELECT operation_id, workspace_id, project_id, document_id, {$before}::int, version, {$actor}::uuid,
                 {$actor}::uuid, {$method}::text FROM r
             )
             SELECT " . self::columns() . ' FROM d',
            [...$params, $userId, $kind, $restoredFrom, $beforeVersion, $kind === 'restore' ? 'restore' : 'manual'],
        )->fetchRow() ?? throw new \UnexpectedValueException('A document write returned no row');
    }

    // Bodies that carry document content may exceed amphp's default 128 KB limit.
    private static function payload(Request $request, string ...$fields): Input
    {
        $request->getBody()->increaseSizeLimit(self::MAX_REQUEST_BYTES);

        return Input::json($request, ...$fields);
    }

    /** @return array{string, string} */
    private static function content(Input $payload): array
    {
        return [$payload->text('title', 1, 200), $payload->text('body', 0, self::MAX_BODY, trim: false)];
    }

    private static function id(Request $request): string
    {
        return Input::uuid($request, 'documentId', '文档');
    }

    // The document as the editor reads it; lists leave out the body.
    private static function columns(bool $body = true): string
    {
        return 'd.id, d.workspace_id AS "workspaceId", d.project_id AS "projectId", d.number, d.title,'
          . ($body ? ' d.body,' : '') . ' d.version, ' . Sql::iso('d.updated_at') . ' AS "updatedAt"';
    }
}
