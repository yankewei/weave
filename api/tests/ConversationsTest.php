<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use Amp\TimeoutCancellation;
use PHPUnit\Framework\TestCase;
use Weave\Api\Json;

use function Amp\async;
use function Amp\delay;

final class ConversationsTest extends TestCase
{
    use ReadsApiResponses;
    use WorkspaceClient;

    private static ?TestServer $shared = null;
    private static ?TestAgent $fixture = null;
    private TestServer $server;
    private TestAgent $agent;

    protected function setUp(): void
    {
        self::$fixture ??= TestAgent::start();
        self::$shared ??= TestServer::start(self::$fixture->url);
        $this->agent = self::$fixture;
        $this->server = self::$shared;
        $this->agent->control(['mode' => '']);
    }

    public function testPrivateConversationReceivesOnceAndConcurrentRetriesReturnSameRun(): void
    {
        [$token, $workspace] = $this->register('持久对话');
        [$member, , , $email] = $this->register('另一成员');
        $this->request('POST', "/api/workspaces/{$workspace}/members", $token, ['email' => $email]);
        $project = $this->project($token, $workspace);
        $path = "/api/projects/{$project}/conversation";
        self::assertSame(['conversation' => null], self::json($this->request('GET', $path, $token)));
        $input = ['requestId' => self::uuid(), 'body' => '需要澄清的目标'];
        $first = async(fn (): TestResponse => $this->request('POST', $path . '/messages', $token, $input));
        $second = async(fn (): TestResponse => $this->request('POST', $path . '/messages', $token, $input));
        $accepted = $first->await(); $again = $second->await();
        self::assertInstanceOf(TestResponse::class, $accepted); self::assertInstanceOf(TestResponse::class, $again);
        self::assertSame(202, $accepted->status, $accepted->body);
        self::assertSame(self::json($accepted), self::json($again));
        $id = self::text(self::json($accepted), 'conversationId');
        $read = self::json($this->request('GET', $path, $token));
        self::assertSame('需要澄清的目标', self::at($read, 'conversation', 'messages', 0, 'body'));
        self::assertSame('running', self::at($read, 'conversation', 'run', 'status'));
        self::assertSame(409, $this->request('POST', $path . '/messages', $token, [...$input, 'body' => '不同消息'])->status);
        self::assertSame(409, $this->request('POST', $path . '/messages', $token, ['requestId' => self::uuid(), 'body' => '另一个问题'])->status);
        self::assertSame(['conversation' => null], self::json($this->request('GET', $path, $member)));
        self::assertSame(404, $this->request('GET', "/api/conversations/{$id}/messages", $member)->status);
        self::assertSame(404, $this->request('GET', "/api/conversations/{$id}/events", $member)->status);
        self::assertSame(400, $this->request('GET', "/api/conversations/{$id}/messages?limit=0", $token)->status);
        self::assertSame(200, $this->request('GET', "/api/conversations/{$id}/messages", $token)->status);
    }

    public function testLostReceiptCanBeRepairedEvenWhenAProposalIsAlreadyPending(): void
    {
        [$token, $workspace] = $this->register('丢失回执');
        $project = $this->project($token, $workspace);
        $path = "/api/projects/{$project}/conversation";
        $input = ['requestId' => self::uuid(), 'body' => '拆分任务'];
        $this->agent->control(['mode' => 'after']);
        self::assertSame(503, $this->request('POST', $path . '/messages', $token, $input)->status);
        $run = $this->server->database->execute('SELECT run_id, conversation_id FROM conversation_inputs WHERE request_id = $1', [$input['requestId']])->fetchRow();
        $runId = self::text($run, 'run_id'); $id = self::text($run, 'conversation_id');
        $proposal = $this->server->request('POST', "/internal/agent/runs/{$runId}/proposal", Json::encode(['summary' => '待确认', 'tasks' => [['title' => '新任务', 'description' => '', 'acceptanceCriteria' => '验证', 'priority' => 'normal']]]), ['authorization' => 'Bearer test']);
        self::assertSame(200, $proposal->status, $proposal->body);
        $retry = $this->request('POST', $path . '/messages', $token, $input);
        self::assertSame(202, $retry->status, $retry->body);
        self::assertSame($runId, self::at(self::json($retry), 'runId'));
        $this->agent->control(['finish' => $id]);
        self::assertSame('pending', self::at(self::json($this->request('GET', $path, $token)), 'conversation', 'run', 'syncStatus'));
        $this->outcome($runId, 'succeeded');
        $this->outcome($runId, 'succeeded');
        $read = self::json($this->request('GET', $path, $token));
        self::assertSame('complete', self::at($read, 'conversation', 'run', 'syncStatus'));
        self::assertSame('pending', self::at($read, 'conversation', 'proposal', 'status'));
        self::assertSame(409, $this->request('POST', $path . '/messages', $token, ['requestId' => self::uuid(), 'body' => '不能越过提案'])->status);
        self::assertSame(409, $this->server->request('PUT', "/internal/agent/runs/{$runId}/outcome", Json::encode(['status' => 'failed', 'model' => 'fixture', 'error' => '不一致']), ['authorization' => 'Bearer test'])->status);
    }

    public function testUnknownAcceptanceIsFencedBeforeANewInputAndUnreachableAgentDoesNotReleaseIt(): void
    {
        [$token, $workspace] = $this->register('接收封存');
        $project = $this->project($token, $workspace);
        $path = "/api/projects/{$project}/conversation/messages";
        $input = ['requestId' => self::uuid(), 'body' => '旧请求'];
        $this->agent->control(['mode' => 'before']);
        self::assertSame(503, $this->request('POST', $path, $token, $input)->status);
        $old = $this->server->database->execute('SELECT admission_id, run_id FROM conversation_inputs WHERE request_id = $1', [$input['requestId']])->fetchRow();
        $this->agent->control(['mode' => 'unreachable']);
        $next = ['requestId' => self::uuid(), 'body' => '新请求'];
        self::assertSame(503, $this->request('POST', $path, $token, $next)->status);
        self::assertSame('accepting', $this->server->database->execute('SELECT status FROM conversation_inputs WHERE request_id = $1', [$input['requestId']])->fetchRow()['status'] ?? null);
        $this->agent->control(['mode' => '']);
        $accepted = $this->request('POST', $path, $token, $next);
        self::assertSame(202, $accepted->status, $accepted->body);
        $closed = self::at($this->agent->control(), 'closed'); self::assertIsArray($closed);
        self::assertContains(self::text($old, 'admission_id'), $closed);
        self::assertSame('closed', $this->server->database->execute('SELECT status FROM conversation_inputs WHERE request_id = $1', [$input['requestId']])->fetchRow()['status'] ?? null);
        self::assertSame(409, $this->request('POST', $path, $token, $input)->status);
        $id = self::text(self::json($accepted), 'conversationId');
        $this->agent->control(['finish' => $id]);
        $this->outcome(self::text(self::json($accepted), 'runId'), 'succeeded');
        $retried = $this->request('POST', $path, $token, $input);
        self::assertSame(202, $retried->status, $retried->body);
        self::assertSame(self::text($old, 'run_id'), self::text(self::json($retried), 'runId'));
        $read = self::json($this->request('GET', "/api/projects/{$project}/conversation", $token));
        self::assertSame(self::text($old, 'run_id'), self::text($read, 'conversation', 'run', 'id'));
        self::assertSame('running', self::at($read, 'conversation', 'run', 'status'));
    }

    public function testMappedStorageIsNeverSilentlyRecreatedAndMalformedRequestIdsDoNotWrite(): void
    {
        [$token, $workspace] = $this->register('映射保护');
        $project = $this->project($token, $workspace);
        $path = "/api/projects/{$project}/conversation";
        self::assertSame(400, $this->request('POST', $path . '/messages', $token, ['requestId' => str_repeat('0', 8) . '-0000-0000-0000-000000000000', 'body' => '无效 UUID'])->status);
        $accepted = $this->request('POST', $path . '/messages', $token, ['requestId' => self::uuid(), 'body' => '有效消息']);
        $id = self::text(self::json($accepted), 'conversationId');
        $before = $this->agent->control(['remove' => $id]);
        self::assertSame(404, $this->request('GET', $path, $token)->status);
        self::assertSame($before['creates'], $this->agent->control()['creates']);
    }

    public function testReadingRepairsAbandonedPreparationOnlyAfterItsWindowAndDurableFence(): void
    {
        [$token, $workspace] = $this->register('读取恢复');
        $project = $this->project($token, $workspace);
        $path = "/api/projects/{$project}/conversation";
        $input = ['requestId' => self::uuid(), 'body' => '未被接收的请求'];
        $this->agent->control(['mode' => 'before']);
        self::assertSame(503, $this->request('POST', $path . '/messages', $token, $input)->status);
        $read = self::json($this->request('GET', $path, $token));
        self::assertSame('accepting', self::at($read, 'conversation', 'run', 'status'));
        $this->server->database->execute("UPDATE conversation_inputs SET admission_started_at = now() - interval '20 seconds' WHERE request_id = $1", [$input['requestId']]);
        $read = self::json($this->request('GET', $path, $token));
        self::assertSame('failed', self::at($read, 'conversation', 'run', 'status'));
        self::assertSame('complete', self::at($read, 'conversation', 'run', 'syncStatus'));
        self::assertSame('closed', $this->server->database->execute('SELECT status FROM conversation_inputs WHERE request_id = $1', [$input['requestId']])->fetchRow()['status'] ?? null);
        self::assertSame(202, $this->request('POST', $path . '/messages', $token, $input)->status);
    }

    public function testSseRelaysBytesAndDisconnectReleasesUpstream(): void
    {
        [$token, $workspace] = $this->register('SSE 透传');
        $project = $this->project($token, $workspace);
        $accepted = $this->request('POST', "/api/projects/{$project}/conversation/messages", $token, ['requestId' => self::uuid(), 'body' => '流式请求']);
        $id = self::text(self::json($accepted), 'conversationId');
        $before = $this->agent->control();
        $disconnected = self::at($before, 'disconnected');
        self::assertIsInt($disconnected);
        $response = $this->server->subscribe("/api/conversations/{$id}/events", $token);
        self::assertSame(200, $response->getStatus());
        self::assertSame('no', $response->getHeader('x-accel-buffering'));
        self::assertSame('identity', $response->getHeader('content-encoding'));
        $chunk = $response->getBody()->read(new TimeoutCancellation(3));
        self::assertIsString($chunk); self::assertStringContainsString('event: snapshot', $chunk);
        self::assertStringContainsString('流式请求', $chunk);
        // A second request must complete while the subscription remains open.
        self::assertSame(200, $this->request('GET', '/api/workspaces', $token)->status);
        $response->getBody()->close();
        $until = microtime(true) + 3;
        do { $after = $this->agent->control(); if ($after['disconnected'] > $before['disconnected']) break; delay(0.05); } while (microtime(true) < $until);
        self::assertGreaterThan($before['disconnected'], $after['disconnected']);
        self::assertSame('running', self::at(self::json($this->request('GET', "/api/projects/{$project}/conversation", $token)), 'conversation', 'run', 'status'));
    }

    public function testOpenStreamsAreRevokedForRemovedMembersAndExpiredSessionsWithoutClientReads(): void
    {
        [$admin, $workspace] = $this->register('订阅撤权');
        [$member, , $memberId, $email] = $this->register('将被移除的成员');
        [$expiring, , $expiringId, $expiringEmail] = $this->register('将过期的会话');
        $this->request('POST', "/api/workspaces/{$workspace}/members", $admin, ['email' => $email]);
        $this->request('POST', "/api/workspaces/{$workspace}/members", $admin, ['email' => $expiringEmail]);
        $responses = [];
        $runs = [];
        foreach ([$member, $expiring] as $token) {
            $project = $this->project($admin, $workspace);
            $accepted = $this->request('POST', "/api/projects/{$project}/conversation/messages", $token, ['requestId' => self::uuid(), 'body' => '持续生成']);
            $id = self::text(self::json($accepted), 'conversationId');
            $runs[] = self::text(self::json($accepted), 'runId');
            $stream = $this->server->subscribe("/api/conversations/{$id}/events", $token);
            self::assertSame(200, $stream->getStatus());
            self::assertNotNull($stream->getBody()->read(new TimeoutCancellation(3)));
            $responses[] = $stream;
        }
        $before = $this->agent->control();
        self::assertSame(204, $this->request('DELETE', "/api/workspaces/{$workspace}/members/{$memberId}", $admin)->status);
        $disconnected = self::at($before, 'disconnected');
        self::assertIsInt($disconnected);
        $this->server->database->execute("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [$expiringId]);
        // Leave both consumers unread. Authorization must run independently of reads/backpressure.
        $until = microtime(true) + 19;
        do {
            $after = $this->agent->control();
            if ($after['disconnected'] >= $disconnected + 2) break;
            delay(0.1);
        } while (microtime(true) < $until);
        self::assertGreaterThanOrEqual($disconnected + 2, $after['disconnected']);
        foreach ($responses as $response) $response->getBody()->close();
        // The service may still finish audit delivery after access is gone; it grants no access or business changes.
        $this->outcome($runs[0], 'failed');
        self::assertSame(401, $this->request('GET', '/api/workspaces', $expiring)->status);
    }

    private function outcome(string $run, string $status): void
    {
        $response = $this->server->request('PUT', "/internal/agent/runs/{$run}/outcome", Json::encode(['status' => $status, 'model' => 'fixture', 'error' => $status === 'failed' ? '已终止' : null]), ['authorization' => 'Bearer test']);
        self::assertSame(200, $response->status, $response->body);
    }

    private static function uuid(): string
    {
        $hex = bin2hex(random_bytes(16));
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-4' . substr($hex, 13, 3) . '-8' . substr($hex, 17, 3) . '-' . substr($hex, 20);
    }
}
