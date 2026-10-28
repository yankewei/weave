<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

/**
 * Roster changes lock every member row in id order, so concurrent invites and
 * removals see one consistent roster and cannot drop the last admin.
 */
final readonly class Members
{
    private const ADMIN_ONLY = '只有管理员可以管理成员。';

    public function __construct(private PostgresConnectionPool $database, private Auth $auth)
    {
    }

    public function list(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Workspaces::id($request);
        Workspaces::role($this->database, $workspaceId, $user['id']);

        return Json::response([...$this->database->execute(
            'SELECT u.id, u.name, u.email, m.role
             FROM workspace_members m JOIN users u ON u.id = m.user_id
             WHERE m.workspace_id = $1 ORDER BY m.role, u.name, u.id',
            [$workspaceId],
        )]);
    }

    public function invite(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Workspaces::id($request);
        $payload = Input::json($request, 'email');
        $email = $payload->email('email');
        $payload->check();

        return Json::response(Sql::transaction($this->database, function (PostgresExecutor $db) use ($workspaceId, $user, $email): array {
            $roles = self::lockRoster($db, $workspaceId, $user['id']);
            if ($roles[$user['id']] !== 'admin') {
                throw new ApiError(403, self::ADMIN_ONLY);
            }
            $account = $db->execute('SELECT id, name, email FROM users WHERE email = $1', [$email])->fetchRow()
                ?? throw new ApiError(404, '没有使用这个邮箱的账号。');
            if (isset($roles[Sql::string($account, 'id')])) {
                throw new ApiError(409, '这个账号已经是工作空间成员。');
            }
            $db->execute(
                "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1, $2, 'member')",
                [$workspaceId, $account['id']],
            );

            return [...$account, 'role' => 'member'];
        }), 201);
    }

    // Members may leave on their own; removing anyone else takes an admin.
    public function remove(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Workspaces::id($request);
        $targetId = Input::uuid($request, 'userId', '成员');

        Sql::transaction($this->database, function (PostgresExecutor $db) use ($workspaceId, $user, $targetId): void {
            $roles = self::lockRoster($db, $workspaceId, $user['id']);
            $target = $roles[$targetId] ?? throw new ApiError(404, Workspaces::MISSING);
            if ($targetId !== $user['id'] && $roles[$user['id']] !== 'admin') {
                throw new ApiError(403, self::ADMIN_ONLY);
            }
            if ($target === 'admin' && count(array_keys($roles, 'admin', true)) < 2) {
                throw new ApiError(409, '工作空间至少要保留一名管理员。');
            }
            self::releaseAssignee($db, $workspaceId, $targetId, $user['id']);
            // Only the initiator can confirm a proposal. Reject it before they lose access.
            $db->execute(
                "UPDATE change_proposals SET status = 'rejected', resolved_at = now()
                 WHERE workspace_id = $1 AND initiator_id = $2 AND status = 'pending'",
                [$workspaceId, $targetId],
            );
            $db->execute('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [$workspaceId, $targetId]);
        });

        return new Response(204);
    }

    /**
     * Locks the roster and answers 404 unless the caller is on it.
     *
     * @return non-empty-array<string, string> Role by user id.
     */
    private static function lockRoster(PostgresExecutor $db, string $workspaceId, string $userId): array
    {
        $roles = [];
        foreach ($db->execute(
            'SELECT user_id, role FROM workspace_members WHERE workspace_id = $1 ORDER BY user_id FOR UPDATE',
            [$workspaceId],
        ) as $row) {
            $roles[Sql::string($row, 'user_id')] = Sql::string($row, 'role');
        }
        if (!isset($roles[$userId])) {
            throw new ApiError(404, Workspaces::MISSING);
        }

        return $roles;
    }

    /**
     * Clears the leaving member from their tasks while the membership row still
     * exists, recording each change as a task edit like the board would.
     */
    private static function releaseAssignee(PostgresExecutor $db, string $workspaceId, string $assigneeId, string $actorId): void
    {
        // Lock in id order first so the update below cannot deadlock with board writes.
        $db->execute(
            'SELECT id FROM tasks WHERE workspace_id = $1 AND assignee_id = $2 ORDER BY id FOR UPDATE',
            [$workspaceId, $assigneeId],
        );

        $db->execute(
            'WITH before AS (
               SELECT t.id, ' . self::taskState('t', 'u.name') . ' AS state
               FROM tasks t JOIN users u ON u.id = t.assignee_id
               WHERE t.workspace_id = $1 AND t.assignee_id = $2
             ), released AS (
               UPDATE tasks t SET assignee_id = NULL, version = t.version + 1, updated_by = $3, updated_at = now()
               FROM before WHERE t.id = before.id
               RETURNING t.*
             )
             INSERT INTO task_events(operation_id, workspace_id, project_id, task_id, version, kind,
               initiator_id, confirmer_id, before_state, after_state)
             SELECT gen_random_uuid(), r.workspace_id, r.project_id, r.id, r.version, \'edit\', $3, $3,
               before.state, ' . self::taskState('r', 'NULL') . '
             FROM released r JOIN before ON before.id = r.id',
            [$workspaceId, $assigneeId, $actorId],
        );
    }

    // The task JSON the board reads, as task_events stores it in before/after_state.
    private static function taskState(string $task, string $assigneeName): string
    {
        return "jsonb_build_object(
          'id', {$task}.id, 'workspaceId', {$task}.workspace_id, 'projectId', {$task}.project_id,
          'number', {$task}.number, 'title', {$task}.title, 'description', {$task}.description,
          'acceptanceCriteria', {$task}.acceptance_criteria, 'status', {$task}.status,
          'priority', {$task}.priority, 'assigneeId', {$task}.assignee_id, 'assigneeName', {$assigneeName},
          'position', {$task}.position::text, 'version', {$task}.version,
          'updatedAt', " . Sql::iso("{$task}.updated_at") . ')';
    }
}
