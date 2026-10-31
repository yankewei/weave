<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use Amp\Postgres\PostgresExecutor;
use PHPUnit\Framework\TestCase;
use Weave\Api\Json;
use Weave\Api\Sql;

use function Amp\async;

final class ProposalsTest extends TestCase
{
    use AssertsApiErrors;
    use ReadsApiResponses;
    use WorkspaceClient;

    private TestServer $server;

    protected function setUp(): void
    {
        $this->server = TestServer::get();
    }

    public function testProposalIsPendingUntilConfirmedAndConcurrentConfirmationCreatesTasksOnce(): void
    {
        [$token, $workspace, $user] = $this->register('提案空间');
        $project = $this->project($token, $workspace);
        $run = $this->seedRun($workspace, $project, $user);
        $firstSubmit = async(fn (): TestResponse => $this->internal($run, 'proposal', self::draft()));
        $secondSubmit = async(fn (): TestResponse => $this->internal($run, 'proposal', self::draft()));
        $submitted = $firstSubmit->await();
        $duplicate = $secondSubmit->await();
        self::assertInstanceOf(TestResponse::class, $submitted);
        self::assertInstanceOf(TestResponse::class, $duplicate);
        self::assertSame(200, $submitted->status, $submitted->body);
        self::assertSame(self::json($submitted), self::json($duplicate));
        $proposal = self::json($submitted);
        $id = self::text($proposal, 'proposal', 'id');
        self::assertSame('pending', self::at($proposal, 'proposal', 'status'));
        self::assertSame([], self::json($this->request('GET', "/api/projects/{$project}/tasks", $token)));
        self::assertSame($proposal, self::json($this->internal($run, 'proposal', self::draft())));
        self::assertSame(409, $this->internal($run, 'proposal', [...self::draft(), 'summary' => '改变摘要'])->status);

        // A tool retry must still work after its execution audit has reached a terminal state.
        $this->server->database->execute("UPDATE ai_runs SET status = 'succeeded', finished_at = now() WHERE id = $1", [$run]);
        self::assertSame($proposal, self::json($this->internal($run, 'proposal', self::draft())));
        $calls = [];
        for ($i = 0; $i < 4; $i++) {
            $calls[] = async(fn (): TestResponse => $this->request('POST', "/api/proposals/{$id}/confirm", $token));
        }
        foreach ($calls as $call) {
            $result = $call->await();
            self::assertInstanceOf(TestResponse::class, $result);
            self::assertSame(200, $result->status, $result->body);
        }
        $tasks = self::json($this->request('GET', "/api/projects/{$project}/tasks", $token));
        self::assertCount(2, $tasks);
        self::assertSame([1, 2], array_column($tasks, 'number'));
        foreach ($tasks as $task) {
            self::assertSame('todo', self::at($task, 'status'));
            self::assertNull(self::at($task, 'assigneeId'));
            $history = self::json($this->request('GET', '/api/tasks/' . self::text($task, 'id') . '/history', $token));
            self::assertCount(1, $history);
            self::assertSame($id, self::at($history, 0, 'proposalId'));
            self::assertSame('create', self::at($history, 0, 'kind'));
        }
        self::assertSame(2, $this->server->database->execute('SELECT task_counter FROM workspaces WHERE id = $1', [$workspace])->fetchRow()['task_counter'] ?? null);
        self::assertSame(409, $this->request('POST', "/api/proposals/{$id}/reject", $token)->status);
    }

    public function testMembersSeeOnlyProposalAndOnlyInitiatorCanResolve(): void
    {
        [$admin, $workspace, $user] = $this->register('共享摘要');
        [$member, , , $email] = $this->register('成员');
        [$outsider] = $this->register('外部成员');
        $this->request('POST', "/api/workspaces/{$workspace}/members", $admin, ['email' => $email]);
        $project = $this->project($admin, $workspace);
        $run = $this->seedRun($workspace, $project, $user);
        $id = self::text(self::json($this->internal($run, 'proposal', self::draft())), 'proposal', 'id');
        $read = self::json($this->request('GET', "/api/proposals/{$id}", $member));
        self::assertSame($user, self::at($read, 'proposal', 'initiator', 'id'));
        self::assertArrayNotHasKey('conversation', $read);
        self::assertSame(403, $this->request('POST', "/api/proposals/{$id}/confirm", $member)->status);
        self::assertSame(404, $this->request('GET', "/api/proposals/{$id}", $outsider)->status);
        self::assertSame(401, $this->request('GET', "/api/proposals/{$id}", null)->status);
        $rejected = $this->request('POST', "/api/proposals/{$id}/reject", $admin);
        self::assertSame('rejected', self::at(self::json($rejected), 'proposal', 'status'));
        self::assertSame(self::json($rejected), self::json($this->request('POST', "/api/proposals/{$id}/reject", $admin)));
        self::assertSame([], self::json($this->request('GET', "/api/projects/{$project}/tasks", $admin)));
    }

    public function testInternalAuthenticationAndStrictProposalValidation(): void
    {
        [$token, $workspace, $user] = $this->register('内部工具校验');
        $run = $this->seedRun($workspace, $this->project($token, $workspace), $user);
        $path = "/internal/agent/runs/{$run}/proposal";
        self::assertSame(401, $this->request('POST', $path, $token, self::draft())->status);
        foreach (["/%69nternal/agent/runs/{$run}/context", "/internal%2fagent/runs/{$run}/context"] as $encoded) {
            $encodedResponse = $this->request('GET', $encoded, $token);
            self::assertSame(401, $encodedResponse->status, $encoded . ': ' . $encodedResponse->body);
        }
        self::assertSame(401, $this->request('GET', '/api/proposals/' . $run, null, null, ['authorization' => 'Bearer test'])->status);
        foreach ([
            ['summary' => '摘要', 'tasks' => []],
            ['summary' => '摘要', 'tasks' => array_fill(0, 9, self::draft()['tasks'][0])],
            [...self::draft(), 'initiatorId' => $user],
            ['summary' => '摘要', 'tasks' => [[...self::draft()['tasks'][0], 'status' => 'done']]],
            ['summary' => '摘要', 'tasks' => [[...self::draft()['tasks'][0], 'title' => str_repeat('长', 201)]]],
        ] as $input) {
            self::assertSame(400, $this->internal($run, 'proposal', $input)->status);
        }
        self::assertSame(0, $this->server->database->execute('SELECT count(*)::int AS n FROM change_proposals WHERE ai_run_id = $1', [$run])->fetchRow()['n'] ?? null);
        self::assertSame(401, $this->internal($run, 'context', null, ['authorization' => 'Bearer wrong'])->status);
    }

    public function testConfirmationRollsBackAllTasksAndCountersWhenHistoryWriteFails(): void
    {
        [$token, $workspace, $user] = $this->register('事务回滚');
        $project = $this->project($token, $workspace);
        $run = $this->seedRun($workspace, $project, $user);
        $id = self::text(self::json($this->internal($run, 'proposal', self::draft())), 'proposal', 'id');
        $this->server->database->query("CREATE FUNCTION reject_proposal_history() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN IF NEW.proposal_id = '{$id}' AND NEW.after_state->>'title' = '验证行为' THEN RAISE EXCEPTION 'test history failure'; END IF; RETURN NEW; END \$\$");
        $this->server->database->query('CREATE TRIGGER reject_proposal_history BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION reject_proposal_history()');
        try {
            self::assertSame(500, $this->request('POST', "/api/proposals/{$id}/confirm", $token)->status);
            self::assertSame([], self::json($this->request('GET', "/api/projects/{$project}/tasks", $token)));
            self::assertSame(0, $this->server->database->execute('SELECT task_counter FROM workspaces WHERE id = $1', [$workspace])->fetchRow()['task_counter'] ?? null);
            self::assertSame('pending', self::at(self::json($this->request('GET', "/api/proposals/{$id}", $token)), 'proposal', 'status'));
        } finally {
            $this->server->database->query('DROP TRIGGER reject_proposal_history ON task_events');
            $this->server->database->query('DROP FUNCTION reject_proposal_history()');
        }
        self::assertSame(200, $this->request('POST', "/api/proposals/{$id}/confirm", $token)->status);
    }

    public function testMemberRemovalCannotLeaveANewPendingProposalAndToolsLoseAccess(): void
    {
        [$admin, $workspace] = $this->register('撤销权限');
        [$member, , $user, $email] = $this->register('提案发起人');
        $this->request('POST', "/api/workspaces/{$workspace}/members", $admin, ['email' => $email]);
        $project = $this->project($admin, $workspace);
        $run = $this->seedRun($workspace, $project, $user);
        $submit = async(fn (): TestResponse => $this->internal($run, 'proposal', self::draft()));
        $remove = async(fn (): TestResponse => $this->request('DELETE', "/api/workspaces/{$workspace}/members/{$user}", $admin));
        $submitted = $submit->await();
        $removed = $remove->await();
        self::assertInstanceOf(TestResponse::class, $submitted);
        self::assertInstanceOf(TestResponse::class, $removed);
        self::assertContains($submitted->status, [200, 404]);
        self::assertSame(204, $removed->status);
        self::assertSame(0, $this->server->database->execute("SELECT count(*)::int AS n FROM change_proposals WHERE ai_run_id = $1 AND status = 'pending'", [$run])->fetchRow()['n'] ?? null);
        self::assertSame(404, $this->internal($run, 'context')->status);
        self::assertSame(404, $this->internal($run, 'proposal', self::draft())->status);
        self::assertSame(404, $this->internal($run, 'references', ['keys' => ['DOC-1']])->status);
    }

    public function testReferencesStayInWorkspaceAndDocumentsAreBounded(): void
    {
        [$token, $workspace, $user] = $this->register('引用资料');
        $project = $this->project($token, $workspace);
        $otherProject = $this->project($token, $workspace, '另一项目');
        $this->request('POST', "/api/projects/{$otherProject}/documents", $token, ['title' => '引用文档', 'body' => str_repeat('文', 12001)]);
        [$outsider, $otherWorkspace] = $this->register('另一工作空间');
        $outsiderProject = $this->project($outsider, $otherWorkspace);
        $this->request('POST', "/api/projects/{$outsiderProject}/documents", $outsider, ['title' => '外部文档一', 'body' => '外部资料']);
        $this->request('POST', "/api/projects/{$outsiderProject}/documents", $outsider, ['title' => '外部文档二', 'body' => '不应泄露的外部资料']);
        $run = $this->seedRun($workspace, $project, $user);
        $result = $this->internal($run, 'references', ['keys' => ['DOC-1', 'DEV-999', 'DOC-1', 'DOC-2']]);
        self::assertSame(200, $result->status, $result->body);
        $references = self::json($result);
        $entries = self::at($references, 'references');
        self::assertIsArray($entries);
        self::assertCount(3, $entries);
        self::assertSame(12000, mb_strlen(self::text($references, 'references', 0, 'content', 'body')));
        self::assertTrue(self::at($references, 'references', 0, 'content', 'truncated'));
        self::assertNull(self::at($references, 'references', 1, 'content'));
        self::assertNull(self::at($references, 'references', 2, 'content'));
        self::assertStringNotContainsString('不应泄露的外部资料', $result->body);
        self::assertSame(400, $this->internal($run, 'references', ['keys' => array_fill(0, 7, 'DOC-1')])->status);
        self::assertSame(400, $this->internal($run, 'references', ['keys' => ['DOC-0']])->status);
        $context = $this->internal($run, 'context');
        self::assertSame(200, $context->status);
        self::assertSame([], self::at(self::json($context), 'documents'));
    }

    /**
     * @param array<string, mixed>|null $body
     * @param array<non-empty-string, string> $headers
     */
    private function internal(string $run, string $action, ?array $body = null, array $headers = []): TestResponse
    {
        // No cookie or browser CSRF header: only the internal service token authenticates tools.
        return $this->server->request($body === null ? 'GET' : 'POST', "/internal/agent/runs/{$run}/{$action}", $body === null ? null : Json::encode($body), ['authorization' => 'Bearer test', 'content-type' => 'application/json', ...$headers]);
    }

    private function seedRun(string $workspace, string $project, string $user): string
    {
        return Sql::transaction($this->server->database, static function (PostgresExecutor $db) use ($workspace, $project, $user): string {
            $ids = $db->query('SELECT gen_random_uuid() AS conversation, gen_random_uuid() AS request, gen_random_uuid() AS run, gen_random_uuid() AS admission')->fetchRow();
            $conversation = Sql::string($ids, 'conversation');
            $run = Sql::string($ids, 'run');
            $db->execute('INSERT INTO conversations(id, workspace_id, project_id, created_by) VALUES($1,$2,$3,$4)', [$conversation, $workspace, $project, $user]);
            $db->execute("INSERT INTO conversation_inputs(conversation_id, request_id, run_id, initiator_id, body_hash, admission_id) VALUES($1,$2,$3,$4,$5,$6)", [$conversation, Sql::string($ids, 'request'), $run, $user, str_repeat('0', 64), Sql::string($ids, 'admission')]);
            $db->execute("INSERT INTO ai_runs(id, workspace_id, conversation_id, input_request_id, initiator_id, status, model) VALUES($1,$2,$3,$4,$5,'running','test')", [$run, $workspace, $conversation, Sql::string($ids, 'request'), $user]);

            return $run;
        });
    }

    /** @return array{summary: string, tasks: list<array{title: string, description: string, acceptanceCriteria: string, priority: string}>} */
    private static function draft(): array
    {
        return ['summary' => '先完成接口，再验证行为。', 'tasks' => [
            ['title' => '实现接口', 'description' => '处理业务规则', 'acceptanceCriteria' => '请求成功', 'priority' => 'normal'],
            ['title' => '验证行为', 'description' => '', 'acceptanceCriteria' => '验收通过', 'priority' => 'high'],
        ]];
    }
}
