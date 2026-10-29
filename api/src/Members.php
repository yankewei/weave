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
            Tasks::release($db, $workspaceId, $targetId, $user['id']);
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
}
