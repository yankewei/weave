<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Future;
use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

use function Amp\async;

/**
 * Every route under a workspace answers 404 to non-members, so outsiders cannot
 * tell a missing workspace from one they may not see.
 */
final readonly class Workspaces
{
    public const MISSING = '工作空间不存在或无权访问。';

    public function __construct(private PostgresConnectionPool $database, private Auth $auth)
    {
    }

    /**
     * The caller's role, checked once per request. `$lock` is a row-locking clause
     * for writes that must not race the caller losing membership.
     *
     * @return 'admin'|'member'
     */
    public static function role(PostgresExecutor $db, string $workspaceId, string $userId, string $lock = ''): string
    {
        $row = $db->execute(
            "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 {$lock}",
            [$workspaceId, $userId],
        )->fetchRow();

        return match ($row['role'] ?? null) {
            'admin' => 'admin',
            'member' => 'member',
            default => throw new ApiError(404, self::MISSING),
        };
    }

    // Every route under /api/workspaces/{workspaceId} names it the same way.
    public static function id(Request $request): string
    {
        return Input::uuid($request, 'workspaceId', '工作空间');
    }

    public function list(Request $request): Response
    {
        $user = $this->auth->requireUser($request);

        return Json::response([...$this->database->execute(
            'SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
             WHERE m.user_id = $1 ORDER BY w.name, w.id',
            [$user['id']],
        )]);
    }

    public function projects(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = self::id($request);
        self::role($this->database, $workspaceId, $user['id']);

        return Json::response([...$this->database->execute(
            'SELECT id, workspace_id AS "workspaceId", name FROM projects WHERE workspace_id = $1 ORDER BY created_at, id',
            [$workspaceId],
        )]);
    }

    public function createProject(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = self::id($request);
        $payload = Input::json($request, 'name');
        $name = $payload->text('name', 1, 100);
        $payload->check();

        return Json::response(Sql::transaction($this->database, function (PostgresExecutor $db) use ($workspaceId, $user, $name): ?array {
            self::role($db, $workspaceId, $user['id'], 'FOR SHARE');

            return $db->execute(
                'INSERT INTO projects(id, workspace_id, name) VALUES(gen_random_uuid(), $1, $2)
                 RETURNING id, workspace_id AS "workspaceId", name',
                [$workspaceId, $name],
            )->fetchRow();
        }), 201);
    }

    // The workbench reads across every project in the workspace, so membership is
    // checked once here and every query stays scoped to the workspace id.
    public function overview(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = self::id($request);
        self::role($this->database, $workspaceId, $user['id']);
        // The three reads are independent, so they run concurrently on separate connections.
        // Only the initiator can resolve a proposal, so only theirs count as waiting.
        $projects = async(fn () => [...$this->database->execute(
            'SELECT p.id, p.name, t.todo, t."inProgress", t.done, d.documents, c."pendingProposals"
             FROM projects p
             CROSS JOIN LATERAL (
               SELECT count(*) FILTER (WHERE status = \'todo\')::int AS todo,
                 count(*) FILTER (WHERE status = \'in_progress\')::int AS "inProgress",
                 count(*) FILTER (WHERE status = \'done\')::int AS done
               FROM tasks WHERE project_id = p.id
             ) t
             CROSS JOIN LATERAL (
               SELECT count(*)::int AS documents FROM documents WHERE project_id = p.id
             ) d
             CROSS JOIN LATERAL (
               SELECT count(*)::int AS "pendingProposals" FROM change_proposals
               WHERE project_id = p.id AND status = \'pending\' AND initiator_id = $2
             ) c
             WHERE p.workspace_id = $1 ORDER BY p.created_at, p.id',
            [$workspaceId, $user['id']],
        )]);
        $documents = async(fn () => [...$this->database->execute(
            'SELECT d.id, d.project_id AS "projectId", p.name AS "projectName", d.title, d.version,
               ' . Sql::iso('d.updated_at') . ' AS "updatedAt", u.name AS "updatedByName"
             FROM documents d JOIN projects p ON p.id = d.project_id JOIN users u ON u.id = d.updated_by
             WHERE d.workspace_id = $1 ORDER BY d.updated_at DESC, d.id LIMIT 6',
            [$workspaceId],
        )]);
        $activity = async(fn () => [...$this->database->execute(
            'SELECT id, kind, action, "projectId", "projectName", "targetId", title, "taskNumber", "taskStatus",
               "fromProposal", "actorName", ' . Sql::iso('"createdAt"') . ' AS "createdAt"
             FROM (
               SELECT e.operation_id AS id, \'task\' AS kind, e.kind AS action, e.project_id AS "projectId",
                 p.name AS "projectName", e.task_id AS "targetId", e.after_state->>\'title\' AS title,
                 t.number AS "taskNumber", e.after_state->>\'status\' AS "taskStatus",
                 e.proposal_id IS NOT NULL AS "fromProposal", u.name AS "actorName", e.created_at AS "createdAt"
               FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = e.project_id
               JOIN users u ON u.id = e.initiator_id
               WHERE e.workspace_id = $1
               UNION ALL
               SELECT r.operation_id, \'document\', r.kind, r.project_id, p.name, r.document_id, r.title,
                 NULL, NULL, false, u.name, r.created_at
               FROM document_revisions r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.actor_id
               WHERE r.workspace_id = $1
             ) a ORDER BY a."createdAt" DESC, id DESC LIMIT 8',
            [$workspaceId],
        )]);

        return Json::response(Future\await([
            'projects' => $projects,
            'documents' => $documents,
            'activity' => $activity,
        ]));
    }

    /** Where a DEV-n or DOC-n key points for a member; unknown keys and workspaces read alike. */
    public function browse(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Input::param($request, 'workspaceId');
        $notFound = new ApiError(404, '这个编号在当前工作空间里没有对应的任务或文档。');
        if (!Input::isUuid($workspaceId) || preg_match('/^(DEV|DOC)-([1-9]\d{0,8})$/i', trim(Input::param($request, 'key')), $match) !== 1) {
            throw $notFound;
        }
        $task = strtoupper($match[1]) === 'DEV';
        $target = $this->database->execute(
            'SELECT x.id, x.project_id AS "projectId" FROM ' . ($task ? 'tasks' : 'documents') . ' x
             JOIN workspace_members m ON m.workspace_id = x.workspace_id AND m.user_id = $1
             WHERE x.workspace_id = $2 AND x.number = $3',
            [$user['id'], $workspaceId, (int) $match[2]],
        )->fetchRow() ?? throw $notFound;
        $project = "/workspaces/{$workspaceId}/projects/" . Sql::string($target, 'projectId');
        $id = Sql::string($target, 'id');

        return Json::response(['path' => $task ? "{$project}/board?task={$id}" : "{$project}/documents/{$id}"]);
    }
}
