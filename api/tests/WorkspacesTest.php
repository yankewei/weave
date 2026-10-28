<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use PHPUnit\Framework\TestCase;

final class WorkspacesTest extends TestCase
{
    use AssertsApiErrors;
    use ReadsApiResponses;

    private const ISO = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/';

    private TestServer $server;

    protected function setUp(): void
    {
        $this->server = TestServer::get();
    }

    public function testListsAndCreatesProjectsForMembersOnly(): void
    {
        [$token, $workspaceId] = $this->register('项目空间');
        [$outsider] = $this->register('别的空间');

        self::assertSame([['id' => $workspaceId, 'name' => '项目空间']], self::json($this->request('GET', '/api/workspaces', $token)));
        $created = $this->request('POST', "/api/workspaces/{$workspaceId}/projects", $token, ['name' => ' 发布 ']);
        self::assertSame(201, $created->status);
        $project = self::json($created);
        self::assertSame(['workspaceId' => $workspaceId, 'name' => '发布'], ['workspaceId' => $project['workspaceId'], 'name' => $project['name']]);
        self::assertSame([$project], self::json($this->request('GET', "/api/workspaces/{$workspaceId}/projects", $token)));

        self::assertError(404, '工作空间不存在或无权访问。', $this->request('GET', "/api/workspaces/{$workspaceId}/projects", $outsider));
        self::assertError(404, '工作空间不存在或无权访问。', $this->request('POST', "/api/workspaces/{$workspaceId}/projects", $outsider, ['name' => '闯入']));
        self::assertError(400, '工作空间 不是有效的标识。', $this->request('GET', '/api/workspaces/nope/projects', $token));
        self::assertError(400, 'extra: 不支持的字段；name: 长度应为 1–100 个字符', $this->request('POST', "/api/workspaces/{$workspaceId}/projects", $token, ['name' => ' ', 'extra' => 1]));
        self::assertError(401, '请先登录。', $this->request('GET', '/api/workspaces', null));
    }

    public function testOverviewSummarisesProjectsDocumentsAndActivity(): void
    {
        [$token, $workspaceId, $userId] = $this->register('工作台空间');
        $projectId = self::text(self::json($this->request('POST', "/api/workspaces/{$workspaceId}/projects", $token, ['name' => '看板'])), 'id');
        $taskId = $this->insertTask($workspaceId, $projectId, $userId, '写测试');
        $documentId = $this->insertDocument($workspaceId, $projectId, $userId);

        $overview = self::json($this->request('GET', "/api/workspaces/{$workspaceId}/overview", $token));

        self::assertSame([[
            'id' => $projectId, 'name' => '看板', 'todo' => 1, 'inProgress' => 0, 'done' => 0,
            'documents' => 1, 'pendingProposals' => 0,
        ]], $overview['projects']);
        self::assertSame($documentId, self::at($overview, 'documents', 0, 'id'));
        self::assertSame(1, self::at($overview, 'documents', 0, 'version'));
        self::assertMatchesRegularExpression(self::ISO, self::text($overview, 'documents', 0, 'updatedAt'));
        $activity = self::at($overview, 'activity');
        self::assertIsArray($activity);
        self::assertSame(['document', 'task'], array_column($activity, 'kind'));
        $task = self::at($activity, 1);
        self::assertIsArray($task);
        unset($task['id'], $task['createdAt']);
        self::assertSame([
            'kind' => 'task', 'action' => 'create', 'projectId' => $projectId, 'projectName' => '看板',
            'targetId' => $taskId, 'title' => '写测试', 'taskNumber' => 1, 'taskStatus' => 'todo',
            'fromProposal' => false, 'actorName' => '测试',
        ], $task);
        self::assertMatchesRegularExpression(self::ISO, self::text($activity, 0, 'createdAt'));
    }

    public function testBrowseResolvesKeysForMembers(): void
    {
        [$token, $workspaceId, $userId] = $this->register('编号空间');
        [$outsider] = $this->register('外人空间');
        $projectId = self::text(self::json($this->request('POST', "/api/workspaces/{$workspaceId}/projects", $token, ['name' => '项目'])), 'id');
        $taskId = $this->insertTask($workspaceId, $projectId, $userId, '任务');
        $documentId = $this->insertDocument($workspaceId, $projectId, $userId);

        self::assertSame(
            ['path' => "/workspaces/{$workspaceId}/projects/{$projectId}/board?task={$taskId}"],
            self::json($this->request('GET', "/api/workspaces/{$workspaceId}/browse/dev-1", $token)),
        );
        self::assertSame(
            ['path' => "/workspaces/{$workspaceId}/projects/{$projectId}/documents/{$documentId}"],
            self::json($this->request('GET', "/api/workspaces/{$workspaceId}/browse/DOC-1", $token)),
        );
        foreach (["/api/workspaces/{$workspaceId}/browse/DEV-2", "/api/workspaces/{$workspaceId}/browse/DEV-0", '/api/workspaces/nope/browse/DEV-1'] as $path) {
            self::assertError(404, '这个编号在当前工作空间里没有对应的任务或文档。', $this->request('GET', $path, $token));
        }
        self::assertError(404, '这个编号在当前工作空间里没有对应的任务或文档。', $this->request('GET', "/api/workspaces/{$workspaceId}/browse/DEV-1", $outsider));
    }

    public function testInvitesAndRemovesMembers(): void
    {
        [$admin, $workspaceId, $adminId] = $this->register('成员空间');
        [$member, , $memberId, $memberEmail] = $this->register('成员自己的空间');
        $projectId = self::text(self::json($this->request('POST', "/api/workspaces/{$workspaceId}/projects", $admin, ['name' => '项目'])), 'id');

        $invited = $this->request('POST', "/api/workspaces/{$workspaceId}/members", $admin, ['email' => strtoupper($memberEmail)]);
        self::assertSame(201, $invited->status);
        self::assertSame(['id' => $memberId, 'name' => '测试', 'email' => $memberEmail, 'role' => 'member'], self::json($invited));
        self::assertSame(['admin', 'member'], array_column(self::json($this->request('GET', "/api/workspaces/{$workspaceId}/members", $member)), 'role'));

        self::assertError(409, '这个账号已经是工作空间成员。', $this->request('POST', "/api/workspaces/{$workspaceId}/members", $admin, ['email' => $memberEmail]));
        self::assertError(404, '没有使用这个邮箱的账号。', $this->request('POST', "/api/workspaces/{$workspaceId}/members", $admin, ['email' => 'nobody-' . bin2hex(random_bytes(4)) . '@example.com']));
        self::assertError(403, '只有管理员可以管理成员。', $this->request('POST', "/api/workspaces/{$workspaceId}/members", $member, ['email' => $memberEmail]));
        self::assertError(403, '只有管理员可以管理成员。', $this->request('DELETE', "/api/workspaces/{$workspaceId}/members/{$adminId}", $member));
        self::assertError(409, '工作空间至少要保留一名管理员。', $this->request('DELETE', "/api/workspaces/{$workspaceId}/members/{$adminId}", $admin));

        $taskId = $this->insertTask($workspaceId, $projectId, $adminId, '交给成员', $memberId);
        self::assertSame(204, $this->request('DELETE', "/api/workspaces/{$workspaceId}/members/{$memberId}", $admin)->status);

        $event = $this->server->database->execute(
            "SELECT version, kind, initiator_id, before_state, after_state FROM task_events WHERE task_id = $1 AND kind = 'edit'",
            [$taskId],
        )->fetchRow();
        self::assertNotNull($event);
        self::assertSame([2, 'edit', $adminId], [$event['version'], $event['kind'], $event['initiator_id']]);
        $before = json_decode(self::text($event, 'before_state'), true);
        $after = json_decode(self::text($event, 'after_state'), true);
        self::assertSame([$memberId, '测试', 1], [self::at($before, 'assigneeId'), self::at($before, 'assigneeName'), self::at($before, 'version')]);
        self::assertSame([null, null, 2, '1024'], [self::at($after, 'assigneeId'), self::at($after, 'assigneeName'), self::at($after, 'version'), self::at($after, 'position')]);
        self::assertMatchesRegularExpression(self::ISO, self::text($after, 'updatedAt'));
        self::assertError(404, '工作空间不存在或无权访问。', $this->request('GET', "/api/workspaces/{$workspaceId}/members", $member));
    }

    public function testAdminsManageEncryptedStorage(): void
    {
        [$admin, $workspaceId] = $this->register('存储空间');
        [$member, , , $memberEmail] = $this->register('存储成员空间');
        $this->request('POST', "/api/workspaces/{$workspaceId}/members", $admin, ['email' => $memberEmail]);
        $input = [
            'endpoint' => 'HTTPS://S3.Example.com:443/',
            'region' => 'auto',
            'bucket' => 'weave-bucket',
            'prefix' => 'images',
            'accessKeyId' => 'AKIAEXAMPLE',
            'secretAccessKey' => ' super-secret-value ',
        ];
        $public = ['endpoint' => 'https://s3.example.com', 'region' => 'auto', 'bucket' => 'weave-bucket', 'prefix' => 'images', 'accessKeyId' => 'AKIAEXAMPLE'];

        self::assertSame(['storage' => null], self::json($this->request('GET', "/api/workspaces/{$workspaceId}/storage", $admin)));
        self::assertError(403, '只有管理员可以设置存储。', $this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $member, $input));
        self::assertError(400, '请填写访问密钥。', $this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $admin, [...$input, 'secretAccessKey' => ' ']));
        self::assertSame(['storage' => $public], self::json($this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $admin, $input)));
        self::assertSame('super-secret-value', $this->storedSecret($workspaceId));

        // Leaving the secret out keeps it, and plaintext saved before encryption is upgraded.
        $this->server->database->execute("UPDATE workspace_storage SET secret_access_key = 'plain' WHERE workspace_id = $1", [$workspaceId]);
        unset($input['secretAccessKey']);
        self::assertSame(['storage' => [...$public, 'bucket' => 'other-bucket']], self::json($this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $admin, [...$input, 'bucket' => 'other-bucket'])));
        self::assertSame('plain', $this->storedSecret($workspaceId));

        self::assertSame(['storage' => null], self::json($this->request('DELETE', "/api/workspaces/{$workspaceId}/storage", $admin)));
        self::assertError(
            400,
            'endpoint: 请填写对象存储的服务地址。；region: 请填写存储区域。；bucket: 桶名需要使用小写字母、数字和连字符。；prefix: 目录只能包含字母、数字、斜线和连字符。',
            $this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $admin, [
                ...$input,
                'endpoint' => 'https://user:pass@s3.example.com',
                'region' => 'eu west',
                'bucket' => 'Bad_Bucket',
                'prefix' => 'images/',
            ]),
        );
    }

    private function storedSecret(string $workspaceId): string
    {
        $row = $this->server->database->execute('SELECT secret_access_key FROM workspace_storage WHERE workspace_id = $1', [$workspaceId])->fetchRow();
        $stored = self::text($row, 'secret_access_key');
        self::assertMatchesRegularExpression('/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/', $stored);
        $decode = static fn (string $part): string => sodium_base642bin($part, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);
        [$iv, $tag, $ciphertext] = array_map($decode, explode('.', substr($stored, 3)));

        return (string) openssl_decrypt($ciphertext, 'aes-256-gcm', (string) base64_decode(TestServer::STORAGE_KEY), OPENSSL_RAW_DATA, $iv, $tag);
    }

    /** @return array{string, string, string, string} Session token, workspace id, user id and email. */
    private function register(string $workspaceName): array
    {
        $email = 'workspace-' . bin2hex(random_bytes(6)) . '@example.com';
        $response = $this->request('POST', '/api/auth/register', null, [
            'email' => $email,
            'password' => 'correct-horse-battery',
            'name' => '测试',
            'workspaceName' => $workspaceName,
        ], ['x-forwarded-for' => '203.0.113.' . random_int(1, 254) . '-' . bin2hex(random_bytes(4))]);
        self::assertSame(200, $response->status);
        $token = self::token($response);
        $userId = self::text(self::json($response), 'id');
        $workspaceId = self::text(self::json($this->request('GET', '/api/workspaces', $token)), 0, 'id');

        return [$token, $workspaceId, $userId, $email];
    }

    // Tasks and documents are still written by legacy, so seed them the way it does.
    private function insertTask(string $workspaceId, string $projectId, string $userId, string $title, ?string $assigneeId = null): string
    {
        $row = $this->server->database->execute(
            "WITH task AS (
               INSERT INTO tasks(id, workspace_id, project_id, number, title, description, acceptance_criteria,
                 status, priority, assignee_id, position, version, updated_by)
               VALUES(gen_random_uuid(), $1, $2, (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE workspace_id = $1),
                 $3, '', '', 'todo', 'normal', $4, 1024, 1, $5)
               RETURNING *
             )
             INSERT INTO task_events(operation_id, workspace_id, project_id, task_id, version, kind, initiator_id, confirmer_id, after_state)
             SELECT gen_random_uuid(), workspace_id, project_id, id, 1, 'create', $5, $5, jsonb_build_object('title', title, 'status', status)
             FROM task RETURNING task_id",
            [$workspaceId, $projectId, $title, $assigneeId, $userId],
        )->fetchRow();

        return self::text($row, 'task_id');
    }

    private function insertDocument(string $workspaceId, string $projectId, string $userId): string
    {
        $row = $this->server->database->execute(
            "WITH document AS (
               INSERT INTO documents(id, workspace_id, project_id, number, title, body, version, updated_by)
               VALUES(gen_random_uuid(), $1, $2, 1, '方案', '', 1, $3)
               RETURNING *
             )
             INSERT INTO document_revisions(operation_id, workspace_id, project_id, document_id, version, kind, title, body, actor_id)
             SELECT gen_random_uuid(), workspace_id, project_id, id, 1, 'create', title, body, $3 FROM document
             RETURNING document_id",
            [$workspaceId, $projectId, $userId],
        )->fetchRow();

        return self::text($row, 'document_id');
    }

    /**
     * @param non-empty-string $method
     * @param array<string, mixed>|null $body
     * @param array<non-empty-string, string> $headers
     */
    private function request(string $method, string $path, ?string $token, ?array $body = null, array $headers = []): TestResponse
    {
        return $this->server->request($method, $path, $body === null ? null : (string) json_encode($body), [
            'content-type' => 'application/json',
            'x-weave-request' => '1',
            ...($token === null ? [] : ['cookie' => "weave_session={$token}"]),
            ...$headers,
        ]);
    }

    // Walks decoded JSON or a row, failing the test at the first missing level.
    private static function at(mixed $value, int|string ...$path): mixed
    {
        foreach ($path as $key) {
            self::assertIsArray($value);
            self::assertArrayHasKey($key, $value);
            $value = $value[$key];
        }

        return $value;
    }

    private static function text(mixed $value, int|string ...$path): string
    {
        $value = self::at($value, ...$path);
        self::assertIsString($value);

        return $value;
    }
}
