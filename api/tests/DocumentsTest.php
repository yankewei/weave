<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use Amp\Http\Server\Driver\HttpDriver;
use PHPUnit\Framework\TestCase;
use Weave\Api\Documents;

final class DocumentsTest extends TestCase
{
    use AssertsApiErrors;
    use ReadsApiResponses;
    use WorkspaceClient;

    private const STALE = '文档已被修改。你的草稿已保留，请查看最新版本后再保存。';

    private TestServer $server;

    protected function setUp(): void
    {
        $this->server = TestServer::get();
    }

    public function testCreatesEditsAndRestoresWithRevisions(): void
    {
        [$token, $workspaceId] = $this->register('文档空间');
        $projectId = $this->project($token, $workspaceId);

        $created = $this->request('POST', "/api/projects/{$projectId}/documents", $token, ['title' => ' 方案 ', 'body' => "第一版\n"]);
        self::assertSame(201, $created->status);
        $document = self::json($created);
        $documentId = self::text($document, 'id');
        self::assertMatchesRegularExpression(self::ISO, self::text($document, 'updatedAt'));
        self::assertSame(
            ['workspaceId' => $workspaceId, 'projectId' => $projectId, 'number' => 1, 'title' => '方案', 'body' => "第一版\n", 'version' => 1],
            array_diff_key($document, ['id' => 0, 'updatedAt' => 0]),
        );
        self::assertSame($document, self::json($this->request('GET', "/api/documents/{$documentId}", $token)));
        $summary = $document;
        unset($summary['body']);
        self::assertSame([$summary], self::json($this->request('GET', "/api/projects/{$projectId}/documents", $token)));

        $edited = self::json($this->request('PUT', "/api/documents/{$documentId}", $token, ['baseVersion' => 1, 'title' => '方案', 'body' => '第二版']));
        self::assertSame([2, '第二版'], [$edited['version'], $edited['body']]);
        // Saving the same content again is a no-op, not a stale write.
        self::assertSame($edited, self::json($this->request('PUT', "/api/documents/{$documentId}", $token, ['baseVersion' => 2, 'title' => '方案', 'body' => '第二版'])));
        self::assertError(409, self::STALE, $this->request('PUT', "/api/documents/{$documentId}", $token, ['baseVersion' => 1, 'title' => '方案', 'body' => '冲突']));

        $restored = self::json($this->request('POST', "/api/documents/{$documentId}/restore", $token, ['baseVersion' => 2, 'revisionVersion' => 1]));
        self::assertSame([3, "第一版\n"], [$restored['version'], $restored['body']]);
        self::assertError(404, '历史版本不存在。', $this->request('POST', "/api/documents/{$documentId}/restore", $token, ['baseVersion' => 3, 'revisionVersion' => 9]));

        $revisions = self::json($this->request('GET', "/api/documents/{$documentId}/revisions", $token));
        self::assertSame([[3, 'restore', 1], [2, 'edit', null], [1, 'create', null]], array_map(
            static fn (mixed $revision): array => [self::at($revision, 'version'), self::at($revision, 'kind'), self::at($revision, 'restoredFromVersion')],
            $revisions,
        ));
        self::assertSame(['测试', "第一版\n"], [self::at($revisions, 0, 'actorName'), self::at($revisions, 0, 'body')]);
        self::assertMatchesRegularExpression(self::ISO, self::text($revisions, 0, 'createdAt'));

        $audit = [...$this->server->database->execute(
            'SELECT a.before_version, a.after_version, a.method FROM audit_events a
             JOIN document_revisions r ON r.operation_id = a.operation_id
             WHERE a.document_id = $1 ORDER BY a.after_version',
            [$documentId],
        )];
        self::assertSame([[null, 1, 'manual'], [1, 2, 'manual'], [2, 3, 'restore']], array_map(array_values(...), $audit));
    }

    public function testAcceptsFullLengthBodiesBeyondTheDefaultRequestLimit(): void
    {
        [$token, $workspaceId] = $this->register('长文空间');
        $projectId = $this->project($token, $workspaceId);
        // 200,000 three-byte characters: about 600 KB, well over amphp's 128 KB default.
        $body = str_repeat('文', 200_000);

        $created = $this->request('POST', "/api/projects/{$projectId}/documents", $token, ['title' => '长文', 'body' => $body]);
        self::assertSame(201, $created->status);
        self::assertSame($body, self::at(self::json($created), 'body'));
        self::assertError(
            400,
            'body: 长度应为 0–200000 个字符',
            $this->request('PUT', '/api/documents/' . self::text(self::json($created), 'id'), $token, ['baseVersion' => 1, 'title' => '长文', 'body' => "{$body}文"]),
        );
    }

    // Only document writes get the larger limit, and it is still a limit. Each body is
    // just over its cap so little is left unread when the server closes the connection.
    public function testRaisesTheBodyLimitOnlyForDocumentWrites(): void
    {
        [$token, $workspaceId] = $this->register('上限空间');
        $projectId = $this->project($token, $workspaceId);

        self::assertError(413, '请求内容过大。', $this->request('POST', "/api/projects/{$projectId}/documents", $token, str_repeat('x', Documents::MAX_REQUEST_BYTES + 1)));
        self::assertError(413, '请求内容过大。', $this->request('POST', "/api/projects/{$projectId}/tasks", $token, str_repeat('x', HttpDriver::DEFAULT_BODY_SIZE_LIMIT + 1)));
    }

    public function testValidatesInputAndHidesOtherWorkspaces(): void
    {
        [$token, $workspaceId] = $this->register('校验文档空间');
        [$outsider] = $this->register('外部文档空间');
        $projectId = $this->project($token, $workspaceId);
        $documentId = self::text(self::json($this->request('POST', "/api/projects/{$projectId}/documents", $token, ['title' => '文档', 'body' => ''])), 'id');

        self::assertError(400, 'extra: 不支持的字段；title: 长度应为 1–200 个字符；body: 必须是字符串', $this->request('POST', "/api/projects/{$projectId}/documents", $token, ['title' => ' ', 'extra' => 1]));
        self::assertError(400, 'baseVersion: 必须是正整数；revisionVersion: 必须是正整数', $this->request('POST', "/api/documents/{$documentId}/restore", $token, ['baseVersion' => 0]));
        self::assertError(400, '文档 不是有效的标识。', $this->request('GET', '/api/documents/nope', $token));
        self::assertError(400, '项目 不是有效的标识。', $this->request('GET', '/api/projects/nope/documents', $token));

        self::assertError(404, '项目不存在或无权访问。', $this->request('GET', "/api/projects/{$projectId}/documents", $outsider));
        self::assertError(404, '项目不存在或无权访问。', $this->request('POST', "/api/projects/{$projectId}/documents", $outsider, ['title' => '闯入', 'body' => '']));
        foreach (["/api/documents/{$documentId}", "/api/documents/{$documentId}/revisions"] as $path) {
            self::assertError(404, '文档不存在或无权访问。', $this->request('GET', $path, $outsider));
        }
        self::assertError(404, '文档不存在或无权访问。', $this->request('PUT', "/api/documents/{$documentId}", $outsider, ['baseVersion' => 1, 'title' => '改', 'body' => '']));
        self::assertError(404, '文档不存在或无权访问。', $this->request('POST', "/api/documents/{$documentId}/restore", $outsider, ['baseVersion' => 1, 'revisionVersion' => 1]));
    }
}
