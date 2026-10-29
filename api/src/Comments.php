<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

// Task comments are one level deep: a reply cannot itself be replied to.
final readonly class Comments
{
    public function __construct(private PostgresConnectionPool $database, private Auth $auth)
    {
    }

    public function list(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $taskId = Tasks::id($request);
        Tasks::read($this->database, $taskId, $user['id']);

        return Json::response([...$this->database->execute(
            'SELECT ' . self::columns() . ' FROM task_comments c JOIN users u ON u.id = c.author_id
             WHERE c.task_id = $1 ORDER BY c.created_at, c.id',
            [$taskId],
        )]);
    }

    public function create(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $taskId = Tasks::id($request);
        $payload = Input::json($request, 'body', 'parentId');
        $body = $payload->text('body', 1, 4000);
        $parentId = $payload->has('parentId') ? $payload->uuidOrNull('parentId') : null;
        $payload->check();

        // Hold the caller's membership and the parent until the insert commits.
        return Json::response(Sql::transaction($this->database, function (PostgresExecutor $db) use ($taskId, $user, $body, $parentId): ?array {
            $task = Tasks::read($db, $taskId, $user['id'], 'FOR SHARE OF m');
            if ($parentId !== null) {
                $parent = $db->execute(
                    'SELECT parent_id FROM task_comments WHERE id = $1 AND task_id = $2 FOR SHARE',
                    [$parentId, $taskId],
                )->fetchRow() ?? throw new ApiError(404, '要回复的评论不存在。');
                if ($parent['parent_id'] !== null) {
                    throw new ApiError(400, '只能回复一级评论。');
                }
            }

            return $db->execute(
                'WITH c AS (
                   INSERT INTO task_comments(id, workspace_id, project_id, task_id, parent_id, author_id, body)
                   VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *
                 )
                 SELECT ' . self::columns() . ' FROM c JOIN users u ON u.id = c.author_id',
                [$task['workspaceId'], $task['projectId'], $taskId, $parentId, $user['id'], $body],
            )->fetchRow();
        }), 201);
    }

    // Authors delete their own comments; replies go with them through the foreign key cascade.
    public function remove(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $taskId = Tasks::id($request);
        $commentId = Input::uuid($request, 'commentId', '评论');

        Sql::transaction($this->database, function (PostgresExecutor $db) use ($taskId, $commentId, $user): void {
            Tasks::read($db, $taskId, $user['id']);
            $comment = $db->execute(
                'SELECT author_id FROM task_comments WHERE id = $1 AND task_id = $2 FOR UPDATE',
                [$commentId, $taskId],
            )->fetchRow() ?? throw new ApiError(404, '评论不存在。');
            if ($comment['author_id'] !== $user['id']) {
                throw new ApiError(403, '只能删除自己的评论。');
            }
            $db->execute('DELETE FROM task_comments WHERE id = $1', [$commentId]);
        });

        return new Response(204);
    }

    private static function columns(): string
    {
        return 'c.id, c.task_id AS "taskId", c.parent_id AS "parentId", c.author_id AS "authorId",
          u.name AS "authorName", c.body, ' . Sql::iso('c.created_at') . ' AS "createdAt"';
    }
}
