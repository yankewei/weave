<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\DeferredCancellation;
use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

final readonly class Conversations
{
    private const INPUT_COLUMNS = 'i.request_id AS "requestId", i.run_id AS "runId", i.admission_id AS "admissionId", i.body_hash AS "bodyHash", i.status, i.agent_submission_id AS "submissionId", r.status AS "runStatus"';

    public function __construct(private PostgresConnectionPool $database, private Auth $auth, private AgentClient $agent)
    {
    }

    /** @return array<string, mixed> */
    public static function owned(PostgresExecutor $db, string $id, string $userId): array
    {
        return $db->execute(
            'SELECT c.id, c.workspace_id AS "workspaceId", c.project_id AS "projectId", c.created_by AS "ownerId",
               c.agent_conversation_id AS "agentConversationId"
             FROM conversations c JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = $2
             WHERE c.id = $1 AND c.created_by = $2', [$id, $userId],
        )->fetchRow() ?? throw new ApiError(404, '对话不存在或无权访问。');
    }

    public function open(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $projectId = Workspaces::projectId($request);
        Workspaces::project($this->database, $projectId, $user['id']);
        $row = $this->database->execute('SELECT id FROM conversations WHERE project_id = $1 AND created_by = $2', [$projectId, $user['id']])->fetchRow();
        if ($row === null) {
            return Json::response(['conversation' => null]);
        }
        $conversation = self::owned($this->database, Sql::string($row, 'id'), $user['id']);
        $this->map($conversation);
        $id = Sql::string($conversation, 'id');
        $snapshot = $this->agent->json('GET', "/conversations/{$id}");
        $unknown = $this->database->execute('SELECT ' . self::INPUT_COLUMNS . ", i.admission_started_at < now() - interval '15 seconds' AS stale FROM conversation_inputs i JOIN ai_runs r ON r.id = i.run_id WHERE i.conversation_id = $1 AND i.status = 'accepting' LIMIT 1", [$id])->fetchRow();
        if ($unknown !== null) $this->reconcile($id, $unknown, ($unknown['stale'] ?? false) === true);
        $messages = self::messagesFrom($snapshot['messages'] ?? null);
        if (($snapshot['conversationId'] ?? null) !== $id || (!is_string($snapshot['nextCursor'] ?? null) && ($snapshot['nextCursor'] ?? null) !== null)) {
            throw new ApiError(502, '对话快照无效。');
        }
        $latest = $this->database->execute(
            'SELECT r.id, i.request_id AS "requestId", i.status AS "inputStatus", r.status, r.error, r.synced_at
             FROM ai_runs r JOIN conversation_inputs i ON i.run_id = r.id WHERE r.conversation_id = $1
             ORDER BY i.admission_started_at DESC, r.id DESC LIMIT 1', [$id],
        )->fetchRow();
        $run = null;
        if ($latest !== null) {
            $run = ['inputStatus' => $latest['inputStatus'], 'id' => $latest['id'], 'requestId' => $latest['requestId'], 'status' => $latest['status'], 'reply' => '', 'message' => $latest['error'], 'syncStatus' => $latest['synced_at'] === null ? 'pending' : 'complete'];
            if ($latest['inputStatus'] === 'accepting' && $latest['status'] === 'running') {
                $run['status'] = 'accepting';
            }
            $agentRun = $snapshot['run'] ?? null;
            if (is_array($agentRun) && ($agentRun['id'] ?? null) === $latest['id'] && ($agentRun['requestId'] ?? null) === $latest['requestId']) {
                if (!in_array($agentRun['status'] ?? null, ['accepting', 'running', 'succeeded', 'failed'], true) || !is_string($agentRun['reply'] ?? null)) {
                    throw new ApiError(502, '执行快照无效。');
                }
                if ($latest['synced_at'] === null && $latest['inputStatus'] !== 'closed') {
                    $run['status'] = $agentRun['status'];
                    $run['reply'] = $agentRun['status'] === 'running' ? $agentRun['reply'] : '';
                    $run['message'] = $agentRun['status'] === 'failed' ? '生成失败，请重新发送。' : null;
                }
            }
        }
        $proposal = $this->database->execute('SELECT id FROM change_proposals WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [$id])->fetchRow();
        // Recheck after upstream I/O; neither a removed membership nor an expired session may receive private text.
        $this->auth->requireUser($request);
        self::owned($this->database, $id, $user['id']);

        return Json::response(['conversation' => [
            'id' => $id, 'workspaceId' => $conversation['workspaceId'], 'projectId' => $projectId,
            'messages' => $messages, 'nextCursor' => $snapshot['nextCursor'] ?? null, 'run' => $run,
            'proposal' => $proposal === null ? null : Proposals::view($this->database, Sql::string($proposal, 'id'), $user['id']),
        ]]);
    }

    public function send(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $projectId = Workspaces::projectId($request);
        $payload = Input::json($request, 'requestId', 'body');
        $requestId = strtolower($payload->text('requestId', 36, 36));
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $requestId) !== 1) {
            $payload->invalid('requestId', '必须是有效的标识');
        }
        $body = $payload->text('body', 1, 8000);
        $payload->check();
        $hash = hash('sha256', $body);
        for ($attempt = 0; $attempt < 3; $attempt++) {
            $plan = Sql::transaction($this->database, function (PostgresExecutor $db) use ($projectId, $user, $requestId, $hash): array {
                $workspace = Workspaces::project($db, $projectId, $user['id'], 'UPDATE');
                $row = $db->execute('SELECT id FROM conversations WHERE project_id = $1 AND created_by = $2', [$projectId, $user['id']])->fetchRow();
                if ($row === null) {
                    $row = $db->execute("INSERT INTO conversations(id, workspace_id, project_id, created_by) VALUES(gen_random_uuid(), $1, $2, $3) RETURNING id", [$workspace, $projectId, $user['id']])->fetchRow();
                }
                $conversation = self::owned($db, Sql::string($row, 'id'), $user['id']);
                $id = Sql::string($conversation, 'id');
                $existing = $db->execute('SELECT ' . self::INPUT_COLUMNS . ' FROM conversation_inputs i JOIN ai_runs r ON r.id = i.run_id WHERE i.conversation_id = $1 AND i.request_id = $2 FOR UPDATE OF i, r', [$id, $requestId])->fetchRow();
                if ($existing !== null && $existing['bodyHash'] !== $hash) {
                    throw new ApiError(409, '同一请求标识的消息内容不一致。');
                }
                if (in_array($existing['status'] ?? null, ['accepted', 'accepting'], true)) {
                    return ['conversation' => $conversation, 'input' => $existing, 'reconcile' => false];
                }
                $other = $db->execute('SELECT ' . self::INPUT_COLUMNS . " FROM conversation_inputs i JOIN ai_runs r ON r.id = i.run_id WHERE i.conversation_id = $1 AND i.request_id <> $2 AND (i.status = 'accepting' OR r.status = 'running') ORDER BY i.created_at LIMIT 1 FOR UPDATE OF i, r", [$id, $requestId])->fetchRow();
                if ($other !== null) {
                    if ($other['status'] === 'accepted') {
                        throw new ApiError(409, '上一次生成或终态同步仍在进行，请稍后重试。');
                    }

                    return ['conversation' => $conversation, 'input' => $other, 'reconcile' => true];
                }
                if ($db->execute("SELECT 1 FROM change_proposals WHERE conversation_id = $1 AND status = 'pending'", [$id])->fetchRow() !== null) {
                    throw new ApiError(409, '请先确认或拒绝当前任务提案。');
                }
                if ($existing === null) {
                    $ids = $db->query('SELECT gen_random_uuid() AS run, gen_random_uuid() AS admission')->fetchRow();
                    $runId = Sql::string($ids, 'run');
                    $admission = Sql::string($ids, 'admission');
                    $db->execute("INSERT INTO conversation_inputs(conversation_id, request_id, run_id, initiator_id, body_hash, admission_id) VALUES($1,$2,$3,$4,$5,$6)", [$id, $requestId, $runId, $user['id'], $hash, $admission]);
                    $db->execute("INSERT INTO ai_runs(id, workspace_id, conversation_id, input_request_id, initiator_id, status, model) VALUES($1,$2,$3,$4,$5,'running','pending')", [$runId, $workspace, $id, $requestId, $user['id']]);
                } elseif ($existing['status'] === 'closed') {
                    $db->execute("UPDATE conversation_inputs SET status = 'accepting', admission_id = gen_random_uuid(), admission_started_at = now() WHERE conversation_id = $1 AND request_id = $2", [$id, $requestId]);
                    $db->execute("UPDATE ai_runs SET status = 'running', error = NULL, started_at = now(), finished_at = NULL, synced_at = NULL WHERE id = $1", [$existing['runId']]);
                }
                $input = $db->execute('SELECT ' . self::INPUT_COLUMNS . ' FROM conversation_inputs i JOIN ai_runs r ON r.id = i.run_id WHERE i.conversation_id = $1 AND i.request_id = $2', [$id, $requestId])->fetchRow();
                if ($input === null) {
                    throw new \UnexpectedValueException('Missing input receipt');
                }

                return ['conversation' => $conversation, 'input' => $input, 'reconcile' => false];
            });
            $conversation = $plan['conversation'];
            $input = $plan['input'];
            $id = Sql::string($conversation, 'id');
            if ($plan['reconcile']) {
                $this->map($conversation);
                $this->reconcile($id, $input);
                continue;
            }
            if ($input['status'] !== 'accepted') {
                $this->map($conversation);
                $receipt = $this->agent->json('POST', "/conversations/{$id}/inputs", [
                    'requestId' => $requestId, 'runId' => $input['runId'], 'admissionId' => $input['admissionId'], 'body' => $body, 'authorName' => $user['name'],
                ]);
                $this->accepted($id, $input, AgentClient::submission($receipt, $id, $input));
            }
            $this->auth->requireUser($request);
            self::owned($this->database, $id, $user['id']);

            return Json::response(['conversationId' => $id, 'requestId' => $requestId, 'runId' => $input['runId'], 'status' => 'accepted'], 202);
        }

        throw new ApiError(409, '对话接收状态正在变化，请使用原请求标识重试。');
    }

    /** @param array<string, mixed> $conversation */
    private function map(array $conversation): void
    {
        if ($conversation['agentConversationId'] !== null) return;
        $id = Sql::string($conversation, 'id');
        $mapped = $this->agent->json('PUT', "/conversations/{$id}", ['workspaceId' => $conversation['workspaceId'], 'projectId' => $conversation['projectId'], 'ownerId' => $conversation['ownerId']]);
        $agentId = $mapped['agentConversationId'] ?? null;
        if (($mapped['conversationId'] ?? null) !== $id || !is_int($agentId) || $agentId < 1) {
            throw new ApiError(502, '对话映射无效。');
        }
        $this->database->execute('UPDATE conversations SET agent_conversation_id = $2 WHERE id = $1 AND agent_conversation_id IS NULL', [$id, $agentId]);
    }

    /** @param array<string, mixed> $input */
    private function accepted(string $id, array $input, int $submission): void
    {
        $this->database->execute("UPDATE conversation_inputs SET status = 'accepted', agent_submission_id = $1 WHERE conversation_id = $2 AND request_id = $3 AND run_id = $4 AND status <> 'closed'", [$submission, $id, $input['requestId'], $input['runId']]);
    }

    /** @param array<string, mixed> $input */
    private function reconcile(string $id, array $input, bool $fenceMissing = true): void
    {
        try {
            $receipt = $this->agent->json('GET', "/conversations/{$id}/inputs/" . Sql::string($input, 'requestId'));
        } catch (ApiError $error) {
            if ($error->status !== 404) {
                throw $error;
            }
            if (!$fenceMissing) return;
            $receipt = $this->agent->json('PUT', "/conversations/{$id}/admissions/" . Sql::string($input, 'admissionId') . '/close', ['requestId' => $input['requestId'], 'runId' => $input['runId']]);
        }
        if (($receipt['status'] ?? null) === 'closed') {
            Sql::transaction($this->database, static function (PostgresExecutor $db) use ($id, $input): void {
                $closed = $db->execute("UPDATE conversation_inputs SET status = 'closed' WHERE conversation_id = $1 AND request_id = $2 AND admission_id = $3 AND status = 'accepting' RETURNING run_id", [$id, $input['requestId'], $input['admissionId']])->fetchRow();
                if ($closed !== null) {
                    $db->execute("UPDATE ai_runs SET status = 'failed', error = '输入未接收，请重试。', finished_at = now(), synced_at = now() WHERE id = $1 AND status = 'running'", [$closed['run_id']]);
                }
            });
        } else {
            $this->accepted($id, $input, AgentClient::submission($receipt, $id, $input));
        }
    }

    public function messages(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $id = Input::uuid($request, 'conversationId', '对话');
        $conversation = self::owned($this->database, $id, $user['id']);
        $this->map($conversation);
        $query = $request->getUri()->getQuery();
        $result = $this->agent->json('GET', "/conversations/{$id}/messages" . ($query === '' ? '' : '?' . $query));
        $messages = self::messagesFrom($result['messages'] ?? null);
        $cursor = $result['nextCursor'] ?? null;
        if ($cursor !== null && !is_string($cursor)) {
            throw new ApiError(502, '历史游标无效。');
        }
        $this->auth->requireUser($request);
        self::owned($this->database, $id, $user['id']);

        return Json::response(['messages' => $messages, 'nextCursor' => $cursor]);
    }

    public function events(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $id = Input::uuid($request, 'conversationId', '对话');
        $conversation = self::owned($this->database, $id, $user['id']);
        $this->map($conversation);
        $cancel = new DeferredCancellation();
        $weakCancellation = \WeakReference::create($cancel);
        $request->getClient()->onClose(static function () use ($weakCancellation): void { $weakCancellation->get()?->cancel(); });
        $upstream = $this->agent->request('GET', "/conversations/{$id}/events", cancellation: $cancel->getCancellation(), stream: true);
        if ($upstream->getStatus() !== 200 || !str_starts_with(strtolower($upstream->getHeader('content-type') ?? ''), 'text/event-stream')) {
            $upstream->getBody()->close();
            throw new ApiError(503, '对话订阅暂不可用。');
        }
        $authorize = function () use ($request, $id, $user): void {
            $this->auth->requireUser($request);
            self::owned($this->database, $id, $user['id']);
        };
        try { $authorize(); }
        catch (\Throwable $error) {
            $cancel->cancel();
            $upstream->getBody()->close();
            throw $error;
        }
        $stream = new ConversationStream($upstream->getBody(), $cancel, $authorize, $request->getClient()->close(...));
        $response = new Response(200, ['content-type' => 'text/event-stream; charset=utf-8', 'content-encoding' => 'identity', 'cache-control' => 'no-cache, no-transform', 'x-accel-buffering' => 'no'], $stream);
        $response->onDispose($stream->close(...));

        return $response;
    }

    /** @return list<array<string, mixed>> */
    private static function messagesFrom(mixed $value): array
    {
        if (!is_array($value) || !array_is_list($value) || count($value) > 100) throw new ApiError(502, '消息列表无效。');
        $messages = [];
        foreach ($value as $message) {
            if (!is_array($message) || !is_string($message['id'] ?? null) || !Input::isUuid($message['id']) || !in_array($message['authorType'] ?? null, ['user', 'assistant'], true)
                || !is_string($message['body'] ?? null) || !is_string($message['createdAt'] ?? null) || !array_key_exists('authorName', $message) || (!is_string($message['authorName']) && $message['authorName'] !== null)) throw new ApiError(502, '消息内容无效。');
            $messages[] = array_intersect_key($message, array_flip(['id', 'authorType', 'authorName', 'body', 'createdAt']));
        }

        return $messages;
    }
}
