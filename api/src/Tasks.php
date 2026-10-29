<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

/**
 * The project task board. Every write locks the project row before it reads the
 * task version, so writes within one project apply one at a time and each one
 * records the before and after task in task_events.
 */
final readonly class Tasks
{
    private const MISSING = '任务不存在或无权访问。';
    private const STALE = '任务已被其他操作修改。请刷新看板后重试，编辑草稿已保留。';
    // The fields the board edits, in the order the task form sends them.
    private const FIELDS = ['title', 'description', 'acceptanceCriteria', 'status', 'priority', 'assigneeId'];
    private const STATUSES = ['todo', 'in_progress', 'done'];
    // Repeated midpoints keep adding digits; past this scale the column is renumbered.
    private const MAX_POSITION_SCALE = 30;

    public function __construct(private PostgresConnectionPool $database, private Auth $auth)
    {
    }

    public static function id(Request $request): string
    {
        return Input::uuid($request, 'taskId', '任务');
    }

    /**
     * The task as the board reads it, or 404 unless the caller is a member of its workspace.
     * `$lock` is a row-locking clause, as for Workspaces::role.
     *
     * @return array<string, mixed>
     */
    public static function read(PostgresExecutor $db, string $taskId, string $userId, string $lock = ''): array
    {
        return $db->execute(
            'SELECT ' . self::columns() . ' FROM tasks t
             JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = $2
             LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = $1 ' . $lock,
            [$taskId, $userId],
        )->fetchRow() ?? throw new ApiError(404, self::MISSING);
    }

    public function list(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $projectId = Workspaces::projectId($request);
        Workspaces::project($this->database, $projectId, $user['id']);

        return Json::response([...$this->database->execute(
            'SELECT ' . self::columns() . ' FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
             WHERE t.project_id = $1 ORDER BY t.position, t.number',
            [$projectId],
        )]);
    }

    // Everyone who can be assigned a task in the project.
    public function members(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Workspaces::project($this->database, Workspaces::projectId($request), $user['id']);

        return Json::response([...$this->database->execute(
            'SELECT u.id, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id
             WHERE m.workspace_id = $1 ORDER BY u.name, u.id',
            [$workspaceId],
        )]);
    }

    public function create(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $projectId = Workspaces::projectId($request);
        $payload = Input::json($request, ...self::FIELDS);
        $input = self::fields($payload);
        $payload->check();

        return Json::response(Sql::transaction($this->database, function (PostgresExecutor $db) use ($projectId, $user, $input): array {
            $workspaceId = Workspaces::project($db, $projectId, $user['id'], 'UPDATE');
            self::checkAssignee($db, $workspaceId, $input['assigneeId']);
            $task = $db->execute(
                'WITH counter AS (
                   UPDATE workspaces SET task_counter = task_counter + 1 WHERE id = $1 RETURNING task_counter
                 ), t AS (
                   INSERT INTO tasks(id, workspace_id, project_id, number, title, description, acceptance_criteria,
                     status, priority, assignee_id, position, version, updated_by)
                   SELECT gen_random_uuid(), $1, $2, task_counter, $3, $4, $5, $6, $7, $8, $9, 1, $10 FROM counter
                   RETURNING *
                 )
                 SELECT ' . self::columns() . ' FROM t LEFT JOIN users u ON u.id = t.assignee_id',
                [
                    $workspaceId, $projectId, $input['title'], $input['description'], $input['acceptanceCriteria'],
                    $input['status'], $input['priority'], $input['assigneeId'],
                    self::positionBefore($db, $projectId, $input['status'], null, null), $user['id'],
                ],
            )->fetchRow() ?? throw new \UnexpectedValueException("Workspace {$workspaceId} has no task counter");
            self::record($db, $user['id'], null, $task, 'create');

            return $task;
        }), 201);
    }

    public function update(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $taskId = self::id($request);
        $payload = Input::json($request, 'baseVersion', ...self::FIELDS);
        $baseVersion = $payload->positiveInt('baseVersion');
        $next = self::fields($payload);
        $payload->check();

        return Json::response($this->change($taskId, $user['id'], $baseVersion, 'edit', static function (PostgresExecutor $db, array $current) use ($taskId, $next): ?array {
            if (array_all(self::FIELDS, static fn (string $field): bool => $current[$field] === $next[$field])) {
                return null;
            }
            if ($next['assigneeId'] !== $current['assigneeId']) {
                self::checkAssignee($db, Sql::string($current, 'workspaceId'), $next['assigneeId']);
            }
            // A task that changes column goes to the bottom of its new one.
            $position = $current['status'] === $next['status']
                ? Sql::string($current, 'position')
                : self::positionBefore($db, Sql::string($current, 'projectId'), $next['status'], $taskId, null);

            return [$next, $position];
        }));
    }

    // Drops the task into a column just before another task, or at the bottom when beforeTaskId is null.
    public function move(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $taskId = self::id($request);
        $payload = Input::json($request, 'baseVersion', 'status', 'beforeTaskId');
        $baseVersion = $payload->positiveInt('baseVersion');
        $status = $payload->choice('status', self::STATUSES);
        $beforeTaskId = $payload->uuidOrNull('beforeTaskId');
        $payload->check();

        return Json::response($this->change($taskId, $user['id'], $baseVersion, 'move', static function (PostgresExecutor $db, array $current) use ($taskId, $status, $beforeTaskId): ?array {
            if ($current['status'] === $status) {
                $next = $db->execute(
                    'SELECT n.id FROM tasks t JOIN tasks n ON n.project_id = t.project_id AND n.status = t.status
                       AND (n.position, n.number) > (t.position, t.number)
                     WHERE t.id = $1 ORDER BY n.position, n.number LIMIT 1',
                    [$taskId],
                )->fetchRow();
                if (($next['id'] ?? null) === $beforeTaskId) {
                    return null;
                }
            }

            return [
                [...$current, 'status' => $status],
                self::positionBefore($db, Sql::string($current, 'projectId'), $status, $taskId, $beforeTaskId),
            ];
        }));
    }

    public function history(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $taskId = self::id($request);
        self::read($this->database, $taskId, $user['id']);
        $events = [];
        foreach ($this->database->execute(
            'SELECT e.operation_id AS "operationId", e.version, e.kind, u.name AS "actorName",
               ' . Sql::iso('e.created_at') . ' AS "createdAt", e.before_state::text AS before,
               e.after_state::text AS after, e.proposal_id AS "proposalId"
             FROM task_events e JOIN users u ON u.id = e.initiator_id WHERE e.task_id = $1 ORDER BY e.version DESC',
            [$taskId],
        ) as $event) {
            $before = $event['before'];
            $events[] = [
                ...$event,
                'before' => is_string($before) ? json_decode($before, flags: JSON_THROW_ON_ERROR) : null,
                'after' => json_decode(Sql::string($event, 'after'), flags: JSON_THROW_ON_ERROR),
            ];
        }

        return Json::response($events);
    }

    /**
     * Applies `$plan` to the task at `$baseVersion`. The plan returns the next
     * board fields and position, or null when the write would change nothing.
     *
     * @param \Closure(PostgresExecutor, array<string, mixed>): (array{array<string, mixed>, string}|null) $plan
     * @return array<string, mixed>
     */
    private function change(string $taskId, string $userId, int $baseVersion, string $kind, \Closure $plan): array
    {
        return Sql::transaction($this->database, function (PostgresExecutor $db) use ($taskId, $userId, $baseVersion, $kind, $plan): array {
            // Serialize on the task's project before reading the version the write is checked against.
            $db->execute(
                'SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
                 JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
                 WHERE t.id = $1 ' . Workspaces::projectLock('UPDATE'),
                [$taskId, $userId],
            )->fetchRow() ?? throw new ApiError(404, self::MISSING);
            $current = self::read($db, $taskId, $userId);
            if ($current['version'] !== $baseVersion) {
                throw new ApiError(409, self::STALE);
            }
            $change = $plan($db, $current);
            if ($change === null) {
                return $current;
            }
            [$next, $position] = $change;

            return self::write($db, $userId, $current, $next, $position, $kind) ?? throw new ApiError(409, self::STALE);
        });
    }

    /**
     * Clears a leaving member from their tasks while their membership row still
     * exists, recording each change as an edit like the board would.
     */
    public static function release(PostgresExecutor $db, string $workspaceId, string $assigneeId, string $actorId): void
    {
        // Lock in id order so concurrent releases cannot deadlock; board writes then fail their version check.
        $tasks = [...$db->execute(
            'SELECT ' . self::columns() . ' FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
             WHERE t.workspace_id = $1 AND t.assignee_id = $2 ORDER BY t.id FOR UPDATE OF t',
            [$workspaceId, $assigneeId],
        )];
        foreach ($tasks as $task) {
            self::write($db, $actorId, $task, [...$task, 'assigneeId' => null], Sql::string($task, 'position'), 'edit');
        }
    }

    /**
     * Writes the next board fields if the task is still at `$current`'s version,
     * and records the change. Null when another write got there first.
     *
     * @param array<string, mixed> $current
     * @param array<string, mixed> $next
     * @return array<string, mixed>|null
     */
    private static function write(PostgresExecutor $db, string $userId, array $current, array $next, string $position, string $kind): ?array
    {
        $updated = $db->execute(
            'WITH t AS (
               UPDATE tasks SET title = $1, description = $2, acceptance_criteria = $3, status = $4, priority = $5,
                 assignee_id = $6, position = $7, version = version + 1, updated_by = $8, updated_at = now()
               WHERE id = $9 AND version = $10
               RETURNING *
             )
             SELECT ' . self::columns() . ' FROM t LEFT JOIN users u ON u.id = t.assignee_id',
            [
                $next['title'], $next['description'], $next['acceptanceCriteria'], $next['status'], $next['priority'],
                $next['assigneeId'], $position, $userId, $current['id'], $current['version'],
            ],
        )->fetchRow();
        if ($updated !== null) {
            self::record($db, $userId, $current, $updated, $kind);
        }

        return $updated;
    }

    /** @return array{title: string, description: string, acceptanceCriteria: string, status: 'todo'|'in_progress'|'done', priority: 'low'|'normal'|'high', assigneeId: ?string} */
    private static function fields(Input $payload): array
    {
        return [
            'title' => $payload->text('title', 1, 200),
            'description' => $payload->text('description', 0, 20_000, trim: false),
            'acceptanceCriteria' => $payload->text('acceptanceCriteria', 0, 20_000, trim: false),
            'status' => $payload->choice('status', self::STATUSES),
            'priority' => $payload->choice('priority', ['low', 'normal', 'high']),
            'assigneeId' => $payload->uuidOrNull('assigneeId'),
        ];
    }

    private static function checkAssignee(PostgresExecutor $db, string $workspaceId, ?string $assigneeId): void
    {
        if ($assigneeId !== null && $db->execute(
            'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
            [$workspaceId, $assigneeId],
        )->fetchRow() === null) {
            throw new ApiError(400, '负责人必须是当前工作空间的成员。');
        }
    }

    /**
     * An exact numeric midpoint between the neighbours keeps the order without
     * rewriting other tasks or their versions. Callers hold the project lock, so
     * renumbering a column cannot race another board write. A null `$taskId` is
     * a task that does not exist yet.
     */
    private static function positionBefore(PostgresExecutor $db, string $projectId, string $status, ?string $taskId, ?string $beforeTaskId): string
    {
        if ($beforeTaskId !== null && $beforeTaskId === $taskId) {
            throw new ApiError(400, '不能将任务放在自身之前。');
        }
        $ordered = [...$db->execute(
            'SELECT id, position::text AS position FROM tasks
             WHERE project_id = $1 AND status = $2 AND id IS DISTINCT FROM $3 ORDER BY position, number',
            [$projectId, $status, $taskId],
        )];
        $index = $beforeTaskId === null ? count($ordered) : array_search($beforeTaskId, array_column($ordered, 'id'), true);
        if ($index === false) {
            throw new ApiError(400, '目标任务不在当前项目的目标列中，请刷新看板。');
        }
        $midpoint = $db->execute(
            'SELECT p::text AS position, scale(p) AS scale FROM (SELECT CASE
               WHEN $2::numeric IS NULL THEN coalesce($1::numeric, 0) + 1024
               WHEN $1::numeric IS NULL THEN $2::numeric - 1024
               ELSE ($1::numeric + $2::numeric) * 0.5 END AS p) AS midpoint',
            [$ordered[$index - 1]['position'] ?? null, $ordered[$index]['position'] ?? null],
        )->fetchRow();
        if (($midpoint['scale'] ?? 0) <= self::MAX_POSITION_SCALE) {
            return Sql::string($midpoint, 'position');
        }
        // Leave a whole step free before the insertion point; position is not part of a task's version.
        $db->execute(
            'UPDATE tasks t SET position = ordered.rank * 1024
             FROM (SELECT id, row_number() OVER (ORDER BY position, number)
                     + CASE WHEN row_number() OVER (ORDER BY position, number) > $4 THEN 1 ELSE 0 END AS rank
                   FROM tasks WHERE project_id = $1 AND status = $2 AND id IS DISTINCT FROM $3) AS ordered
             WHERE t.id = ordered.id',
            [$projectId, $status, $taskId, $index],
        );

        return (string) (($index + 1) * 1024);
    }

    /**
     * @param array<string, mixed>|null $before
     * @param array<string, mixed> $after
     */
    private static function record(PostgresExecutor $db, string $userId, ?array $before, array $after, string $kind): void
    {
        $db->execute(
            'INSERT INTO task_events(operation_id, workspace_id, project_id, task_id, version, kind,
               initiator_id, confirmer_id, before_state, after_state)
             VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, $6, $7::jsonb, $8::jsonb)',
            [
                $after['workspaceId'], $after['projectId'], $after['id'], $after['version'], $kind, $userId,
                $before === null ? null : Json::encode($before),
                Json::encode($after),
            ],
        );
    }

    // The task JSON the board reads, and what task_events stores as before/after_state.
    private static function columns(): string
    {
        return 't.id, t.workspace_id AS "workspaceId", t.project_id AS "projectId", t.number, t.title,
          t.description, t.acceptance_criteria AS "acceptanceCriteria", t.status, t.priority,
          t.assignee_id AS "assigneeId", u.name AS "assigneeName", t.position::text AS position, t.version,
          ' . Sql::iso('t.updated_at') . ' AS "updatedAt"';
    }
}
