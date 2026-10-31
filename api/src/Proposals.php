<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

final readonly class Proposals
{
    private const MISSING = '提案不存在或无权访问。';

    public function __construct(private PostgresConnectionPool $database, private Auth $auth)
    {
    }

    public function read(Request $request): Response
    {
        $user = $this->auth->requireUser($request);

        return Json::response(['proposal' => self::view($this->database, Input::uuid($request, 'proposalId', '提案'), $user['id'])]);
    }

    public function resolve(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $proposalId = Input::uuid($request, 'proposalId', '提案');
        $decision = match (Input::param($request, 'decision')) {
            'confirm' => 'applied',
            'reject' => 'rejected',
            default => throw new ApiError(404, '接口不存在。'),
        };

        return Json::response(['proposal' => Sql::transaction($this->database, function (PostgresExecutor $db) use ($user, $proposalId, $decision): array {
            $current = $db->execute('SELECT workspace_id, project_id, initiator_id FROM change_proposals WHERE id = $1', [$proposalId])->fetchRow()
                ?? throw new ApiError(404, self::MISSING);
            // Membership before proposal/task locks: member removal holds the roster first too.
            Workspaces::role($db, Sql::string($current, 'workspace_id'), $user['id'], 'FOR SHARE');
            if ($current['initiator_id'] !== $user['id']) {
                throw new ApiError(403, '只有发起人可以处理这份提案。');
            }
            $workspaceId = Workspaces::project($db, Sql::string($current, 'project_id'), $user['id'], 'UPDATE');
            $locked = $db->execute('SELECT status FROM change_proposals WHERE id = $1 FOR UPDATE', [$proposalId])->fetchRow();
            if (($locked['status'] ?? null) === $decision) {
                return self::view($db, $proposalId, $user['id']);
            }
            if (($locked['status'] ?? null) !== 'pending') {
                throw new ApiError(409, '这份提案已经处理过。');
            }
            if ($decision === 'applied') {
                foreach ($db->execute('SELECT id, title, description, acceptance_criteria, priority FROM proposal_items WHERE proposal_id = $1 ORDER BY position', [$proposalId]) as $item) {
                    $task = Tasks::insert($db, $user['id'], Sql::string($current, 'project_id'), $workspaceId, [
                        'title' => Sql::string($item, 'title'), 'description' => Sql::string($item, 'description'),
                        'acceptanceCriteria' => Sql::string($item, 'acceptance_criteria'),
                        'priority' => Sql::string($item, 'priority'), 'status' => 'todo', 'assigneeId' => null,
                    ], ['proposalId' => $proposalId, 'proposalItemId' => Sql::string($item, 'id')]);
                    $db->execute('UPDATE proposal_items SET task_id = $2 WHERE id = $1', [$item['id'], $task['id']]);
                }
            }
            $db->execute('UPDATE change_proposals SET status = $2, resolved_at = now() WHERE id = $1', [$proposalId, $decision]);

            return self::view($db, $proposalId, $user['id']);
        })]);
    }

    public function submit(Request $request): Response
    {
        $runId = Input::uuid($request, 'runId', '执行');
        $raw = Json::object($request);
        $payload = new Input($raw, 'summary', 'tasks');
        $summary = $payload->text('summary', 1, 4000);
        $tasks = $raw['tasks'] ?? null;
        if (!is_array($tasks) || !array_is_list($tasks) || count($tasks) < 1 || count($tasks) > 8) {
            $payload->invalid('tasks', '必须包含 1–8 个任务');
            $tasks = [];
        }
        $items = [];
        foreach ($tasks as $item) {
            if (!is_array($item) || array_is_list($item)) {
                throw new ApiError(400, '任务条目必须是 JSON 对象。');
            }
            $fields = new Input($item, 'title', 'description', 'acceptanceCriteria', 'priority');
            $items[] = [
                'title' => $fields->text('title', 1, 200),
                'description' => $fields->text('description', 0, 20_000, trim: false),
                'acceptanceCriteria' => $fields->text('acceptanceCriteria', 0, 20_000, trim: false),
                'priority' => $fields->choice('priority', ['low', 'normal', 'high']),
            ];
            $fields->check();
        }
        $payload->check();
        $hash = hash('sha256', Json::encode(['summary' => $summary, 'tasks' => $items]));

        return Json::response(['proposal' => Sql::transaction($this->database, function (PostgresExecutor $db) use ($runId, $summary, $items, $hash): array {
            $run = AgentTools::run($db, $runId);
            $db->execute('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [$run['conversationId']])->fetchRow();
            $locked = $db->execute('SELECT status FROM ai_runs WHERE id = $1 FOR UPDATE', [$runId])->fetchRow();
            $existing = $db->execute('SELECT id, content_hash FROM change_proposals WHERE ai_run_id = $1', [$runId])->fetchRow();
            if ($existing !== null) {
                if ($existing['content_hash'] !== $hash) {
                    throw new ApiError(409, '同一次执行的提案内容不一致。');
                }

                return self::view($db, Sql::string($existing, 'id'), $run['initiatorId']);
            }
            if (($locked['status'] ?? null) !== 'running') {
                throw new ApiError(409, '这次执行已经结束。');
            }
            if ($db->execute("SELECT 1 FROM change_proposals WHERE conversation_id = $1 AND status = 'pending'", [$run['conversationId']])->fetchRow() !== null) {
                throw new ApiError(409, '请先处理当前待确认提案。');
            }
            $proposal = $db->execute(
                "INSERT INTO change_proposals(id, workspace_id, project_id, conversation_id, ai_run_id, initiator_id, status, summary, content_hash)
                 VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING id",
                [$run['workspaceId'], $run['projectId'], $run['conversationId'], $runId, $run['initiatorId'], $summary, $hash],
            )->fetchRow();
            $proposalId = Sql::string($proposal, 'id');
            foreach ($items as $position => $item) {
                $db->execute(
                    'INSERT INTO proposal_items(id, proposal_id, position, title, description, acceptance_criteria, priority)
                     VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6)',
                    [$proposalId, $position + 1, $item['title'], $item['description'], $item['acceptanceCriteria'], $item['priority']],
                );
            }

            return self::view($db, $proposalId, $run['initiatorId']);
        })]);
    }

    /** @return array<string, mixed> */
    public static function view(PostgresExecutor $db, string $proposalId, string $userId): array
    {
        $proposal = $db->execute(
            'SELECT p.id, p.status, p.summary, p.initiator_id AS "initiatorId", u.name AS "initiatorName",
               ' . Sql::iso('p.created_at') . ' AS "createdAt", ' . Sql::iso('p.resolved_at') . ' AS "resolvedAt"
             FROM change_proposals p JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
             JOIN users u ON u.id = p.initiator_id WHERE p.id = $1',
            [$proposalId, $userId],
        )->fetchRow() ?? throw new ApiError(404, self::MISSING);
        $proposal['initiator'] = ['id' => $proposal['initiatorId'], 'name' => $proposal['initiatorName']];
        unset($proposal['initiatorId'], $proposal['initiatorName']);
        $proposal['items'] = [...$db->execute(
            'SELECT i.id, i.title, i.description, i.acceptance_criteria AS "acceptanceCriteria", i.priority,
               i.task_id AS "taskId", t.number AS "taskNumber"
             FROM proposal_items i LEFT JOIN tasks t ON t.id = i.task_id WHERE i.proposal_id = $1 ORDER BY i.position',
            [$proposalId],
        )];

        return $proposal;
    }
}
