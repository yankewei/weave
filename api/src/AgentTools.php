<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

final readonly class AgentTools
{
    public function __construct(private PostgresConnectionPool $database)
    {
    }

    /**
     * Internal tools can act only for a new durable input belonging to its owner.
     * The membership share lock serializes all reads/writes against roster removal.
     * @return array{id: string, workspaceId: string, projectId: string, conversationId: string, initiatorId: string}
     */
    public static function run(PostgresExecutor $db, string $runId): array
    {
        $row = $db->execute(
            'SELECT r.id, r.workspace_id, c.project_id, r.conversation_id, r.initiator_id
             FROM ai_runs r JOIN conversations c ON c.id = r.conversation_id AND c.workspace_id = r.workspace_id
               AND c.created_by = r.initiator_id
             WHERE r.id = $1 AND r.input_request_id IS NOT NULL',
            [$runId],
        )->fetchRow() ?? throw new ApiError(404, '执行不存在或无权访问。');
        Workspaces::role($db, Sql::string($row, 'workspace_id'), Sql::string($row, 'initiator_id'), 'FOR SHARE');

        return [
            'id' => Sql::string($row, 'id'), 'workspaceId' => Sql::string($row, 'workspace_id'),
            'projectId' => Sql::string($row, 'project_id'), 'conversationId' => Sql::string($row, 'conversation_id'),
            'initiatorId' => Sql::string($row, 'initiator_id'),
        ];
    }

    public function context(Request $request): Response
    {
        $runId = Input::uuid($request, 'runId', '执行');

        return Json::response(Sql::transaction($this->database, static function (PostgresExecutor $db) use ($runId): array {
            $run = self::run($db, $runId);

            return [
                'projectName' => $db->execute('SELECT name FROM projects WHERE id = $1', [$run['projectId']])->fetchRow()['name'] ?? '',
                'tasks' => [...$db->execute('SELECT number, title, status FROM tasks WHERE project_id = $1 ORDER BY number LIMIT 40', [$run['projectId']])],
                'documents' => [...$db->execute('SELECT number, title FROM documents WHERE project_id = $1 ORDER BY number LIMIT 40', [$run['projectId']])],
            ];
        }));
    }

    public function references(Request $request): Response
    {
        $runId = Input::uuid($request, 'runId', '执行');
        $raw = Json::object($request);
        $payload = new Input($raw, 'keys');
        $keys = $raw['keys'] ?? null;
        if (!is_array($keys) || !array_is_list($keys) || count($keys) > 6) {
            throw new ApiError(400, 'keys 必须是最多 6 个编号的列表。');
        }
        $payload->check();
        foreach ($keys as $key) {
            if (!is_string($key) || preg_match('/^(DEV|DOC)-[1-9][0-9]{0,8}$/', $key) !== 1) {
                throw new ApiError(400, '引用编号无效。');
            }
        }

        return Json::response(Sql::transaction($this->database, static function (PostgresExecutor $db) use ($runId, $keys): array {
            $run = self::run($db, $runId);
            $references = [];
            foreach (array_unique($keys) as $key) {
                $number = (int) substr($key, 4);
                // Table and columns are selected by the validated domain prefix, never supplied SQL.
                $isTask = str_starts_with($key, 'DEV-');
                $table = $isTask ? 'tasks' : 'documents';
                $fields = $isTask ? 'x.description, x.acceptance_criteria AS "acceptanceCriteria", x.status' : 'left(x.body, 12000) AS body, length(x.body) > 12000 AS truncated';
                $entry = $db->execute(
                    "SELECT x.title, p.name AS \"projectName\", {$fields} FROM {$table} x JOIN projects p ON p.id = x.project_id
                     WHERE x.workspace_id = $1 AND x.number = $2",
                    [$run['workspaceId'], $number],
                )->fetchRow();
                $references[] = ['key' => $key, 'content' => $entry];
            }

            return ['references' => $references];
        }));
    }

    public function outcome(Request $request): Response
    {
        $runId = Input::uuid($request, 'runId', '执行');
        $raw = Json::object($request);
        $payload = new Input($raw, 'status', 'model', 'error');
        $status = $payload->choice('status', ['succeeded', 'failed']);
        $model = $payload->text('model', 1, 100);
        if (!array_key_exists('error', $raw) || ($status === 'succeeded' && $raw['error'] !== null) || ($status === 'failed' && (!is_string($raw['error']) || mb_strlen($raw['error']) > 500))) {
            $payload->invalid('error', '必须与执行终态一致');
        }
        // The public error is fixed here; raw tool/provider errors never become UI text.
        $payload->check();
        Sql::transaction($this->database, static function (PostgresExecutor $db) use ($runId, $status, $model): void {
            $run = $db->execute(
                'SELECT r.status, r.model FROM ai_runs r JOIN conversations c ON c.id = r.conversation_id
                 AND c.created_by = r.initiator_id AND c.workspace_id = r.workspace_id
                 WHERE r.id = $1 AND r.input_request_id IS NOT NULL FOR UPDATE OF r', [$runId],
            )->fetchRow() ?? throw new ApiError(404, '执行不存在。');
            // Audit completion must still arrive after membership removal; it never restores access or applies proposals.
            if ($run['status'] !== 'running' && ($run['status'] !== $status || $run['model'] !== $model)) {
                throw new ApiError(409, '执行终态不一致。');
            }
            $db->execute('UPDATE ai_runs SET status = $2, model = $3, error = $4, finished_at = coalesce(finished_at, now()), synced_at = coalesce(synced_at, now()) WHERE id = $1', [$runId, $status, $model, $status === 'failed' ? '生成失败，请重新发送。' : null]);
        });

        return Json::response(['status' => 'acknowledged']);
    }
}
