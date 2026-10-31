<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use Amp\DeferredFuture;
use Amp\Future;
use Amp\Http\Server\DefaultErrorHandler;
use Amp\Http\Server\Request;
use Amp\Http\Server\RequestHandler\ClosureRequestHandler;
use Amp\Http\Server\Response;
use Amp\Http\Server\SocketHttpServer;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Weave\Api\Uploads;

use function Amp\async;

final class UploadsTest extends TestCase
{
    use AssertsApiErrors;
    use ReadsApiResponses;
    use WorkspaceClient;

    private const PNG = "\x89PNG\r\n\x1a\nnot-really-pixels";
    private const BOUNDARY = 'weave-test-boundary';

    private TestServer $server;
    private ?SocketHttpServer $store = null;
    /** @var list<string> Requests the fake store received. */
    private array $storeRequests = [];

    protected function setUp(): void
    {
        $this->server = TestServer::get();
    }

    protected function tearDown(): void
    {
        $this->store?->stop();
    }

    public function testStoresImagesInTheDefaultStoreAndServesThemToMembers(): void
    {
        [$token, $workspaceId] = $this->register('图片空间');
        [$outsider] = $this->register('外部图片空间');
        $projectId = $this->project($token, $workspaceId);

        $created = $this->upload($token, $projectId, 'a[b](c).png', self::PNG);
        self::assertSame(201, $created->status);
        $upload = self::json($created);
        $id = self::text($upload, 'id');
        self::assertSame(['id' => $id, 'url' => "/api/uploads/{$id}", 'fileName' => 'abc.png'], $upload);

        $read = $this->request('GET', "/api/uploads/{$id}", $token);
        self::assertSame(200, $read->status);
        self::assertSame(self::PNG, $read->body);
        self::assertSame([
            'image/png', (string) strlen(self::PNG), "inline; filename*=UTF-8''abc.png", 'private, max-age=300', 'nosniff',
            "default-src 'none'; sandbox",
        ], array_map($read->header(...), [
            'content-type', 'content-length', 'content-disposition', 'cache-control', 'x-content-type-options',
            'content-security-policy',
        ]));
        $key = "weave/{$workspaceId}/{$id}.png";
        self::assertSame(200, $this->server->objectStore(TestServer::S3_BUCKET)->get($key)->getStatus());

        self::assertError(404, '图片不存在或无权访问。', $this->request('GET', "/api/uploads/{$id}", $outsider));
        self::assertError(400, '图片 不是有效的标识。', $this->request('GET', '/api/uploads/nope', $token));
        $this->server->objectStore(TestServer::S3_BUCKET)->delete($key);
        self::assertError(404, '图片已不在存储中。', $this->request('GET', "/api/uploads/{$id}", $token));
    }

    public function testRejectsFilesThatAreNotSmallImages(): void
    {
        [$token, $workspaceId] = $this->register('校验图片空间');
        [$outsider] = $this->register('外部校验空间');
        $projectId = $this->project($token, $workspaceId);

        self::assertError(400, '只支持 PNG、JPEG、GIF 和 WebP 图片。', $this->upload($token, $projectId, 'x.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'));
        self::assertError(400, '图片是空的。', $this->upload($token, $projectId, 'empty.png', ''));
        self::assertError(400, '请选择要上传的图片。', $this->request('POST', "/api/projects/{$projectId}/uploads", $token, ['file' => 'x']));
        self::assertError(413, '图片不能超过 4 MB。', $this->upload($token, $projectId, 'big.png', self::PNG . str_repeat('x', Uploads::MAX_BYTES)));
        // Refused from Content-Length before it is read; the message survives the unread body.
        // Just over the cap, so little is left unread when the server closes the connection.
        self::assertError(413, '图片不能超过 4 MB。', $this->request('POST', "/api/projects/{$projectId}/uploads", $token, str_repeat('x', Uploads::MAX_REQUEST_BYTES + 1), [
            'content-type' => 'multipart/form-data; boundary=' . self::BOUNDARY,
        ]));
        self::assertError(404, '项目不存在或无权访问。', $this->upload($outsider, $projectId, 'x.png', self::PNG));
    }

    public function testReportsAStoreThatRefusesTheWrite(): void
    {
        [$token, $workspaceId] = $this->register('坏存储空间');
        $projectId = $this->project($token, $workspaceId);
        $this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $token, [
            ...$this->workspaceStorage(),
            'bucket' => 'weave-test-missing-bucket',
        ]);

        self::assertError(502, '图片上传到工作空间存储失败（404），请检查存储配置。', $this->upload($token, $projectId, 'x.png', self::PNG));
        self::assertSame([], [...$this->server->database->execute('SELECT id FROM uploads WHERE workspace_id = $1', [$workspaceId])]);
    }

    public function testUsesTheWorkspaceBucketWhileItIsConfigured(): void
    {
        [$token, $workspaceId] = $this->register('自有存储空间');
        $projectId = $this->project($token, $workspaceId);
        $bucket = 'weave-test-workspace';
        self::assertSame(200, $this->server->objectStore($bucket)->createBucket(timeout: 5));
        $saved = $this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $token, [...$this->workspaceStorage(), 'bucket' => $bucket]);
        self::assertSame(200, $saved->status, $saved->body);

        $id = self::text(self::json($this->upload($token, $projectId, '截图.gif', 'GIF89a-pixels')), 'id');
        $object = $this->server->objectStore($bucket)->get("images/weave/{$workspaceId}/{$id}.gif");
        self::assertSame([200, 'GIF89a-pixels'], [$object->getStatus(), $object->getBody()->buffer()]);
        $read = $this->request('GET', "/api/uploads/{$id}", $token);
        self::assertSame(['image/gif', "inline; filename*=UTF-8''" . rawurlencode('截图.gif')], [$read->header('content-type'), $read->header('content-disposition')]);

        self::assertSame(200, $this->request('DELETE', "/api/workspaces/{$workspaceId}/storage", $token)->status);
        self::assertError(404, '工作空间已不再使用这张图片所在的存储。', $this->request('GET', "/api/uploads/{$id}", $token));
    }

    public function testTreatsAnyTwoHundredAnswerAsSaved(): void
    {
        [$token, $workspaceId] = $this->register('宽松存储空间');
        $projectId = $this->project($token, $workspaceId);
        $this->useFakeStore($token, $workspaceId, static fn (): Response => new Response(204));

        self::assertSame(201, $this->upload($token, $projectId, 'x.png', self::PNG)->status);
    }

    public function testDoesNotFollowRedirectsFromAStore(): void
    {
        [$token, $workspaceId] = $this->register('跳转存储空间');
        $projectId = $this->project($token, $workspaceId);
        $this->useFakeStore($token, $workspaceId, static fn (): Response => new Response(302, ['location' => '/secret']));

        self::assertError(502, '图片上传到工作空间存储失败（302），请检查存储配置。', $this->upload($token, $projectId, 'x.png', self::PNG));
        self::assertSame([], [...$this->server->database->execute('SELECT id FROM uploads WHERE workspace_id = $1', [$workspaceId])]);
        self::assertCount(1, $this->storeRequests);

        $this->store?->stop();
        $this->useFakeStore($token, $workspaceId, static fn (Request $request): Response => $request->getMethod() === 'PUT'
            ? new Response(200)
            : new Response(302, ['location' => '/secret']));
        $id = self::text(self::json($this->upload($token, $projectId, 'x.png', self::PNG)), 'id');
        self::assertError(502, '读取工作空间存储失败，请检查存储配置。', $this->request('GET', "/api/uploads/{$id}", $token));
        self::assertNotContains('GET /secret', $this->storeRequests);
    }

    public function testRefusesUploadsBeyondTheConcurrencyLimit(): void
    {
        [$token, $workspaceId] = $this->register('繁忙存储空间');
        $projectId = $this->project($token, $workspaceId);
        $release = new DeferredFuture();
        $this->useFakeStore($token, $workspaceId, static function () use ($release): Response {
            $release->getFuture()->await();

            return new Response(200);
        });

        $uploads = [];
        for ($i = 0; $i <= Uploads::MAX_CONCURRENT_UPLOADS; $i++) {
            $uploads[] = async(fn (): TestResponse => $this->upload($token, $projectId, 'x.png', self::PNG));
        }
        $refused = Future\awaitFirst($uploads);
        self::assertInstanceOf(TestResponse::class, $refused);
        self::assertError(503, '图片上传繁忙，请稍后重试。', $refused);
        $release->complete();

        $saved = 0;
        foreach (Future\await($uploads) as $response) {
            self::assertInstanceOf(TestResponse::class, $response);
            $saved += $response->status === 201 ? 1 : 0;
        }
        self::assertSame(Uploads::MAX_CONCURRENT_UPLOADS, $saved);
    }

    /**
     * Points the workspace at a local server, for answers a real store does not give.
     *
     * @param \Closure(Request): Response $answer
     */
    private function useFakeStore(string $token, string $workspaceId, \Closure $answer): void
    {
        $this->store = SocketHttpServer::createForDirectAccess(new NullLogger());
        $this->store->expose('127.0.0.1:0');
        $this->store->start(new ClosureRequestHandler(function (Request $request) use ($answer): Response {
            $request->getBody()->buffer();
            $this->storeRequests[] = "{$request->getMethod()} {$request->getUri()->getPath()}";

            return $answer($request);
        }), new DefaultErrorHandler());

        $saved = $this->request('PUT', "/api/workspaces/{$workspaceId}/storage", $token, [
            ...$this->workspaceStorage(),
            'endpoint' => 'http://' . $this->store->getServers()[0]->getAddress()->toString(),
        ]);
        self::assertSame(200, $saved->status, $saved->body);
    }

    private function upload(string $token, string $projectId, string $name, string $bytes): TestResponse
    {
        $body = '--' . self::BOUNDARY . "\r\n"
            . "Content-Disposition: form-data; name=\"file\"; filename=\"{$name}\"\r\n"
            . "Content-Type: application/octet-stream\r\n\r\n"
            . $bytes . "\r\n--" . self::BOUNDARY . "--\r\n";

        return $this->request('POST', "/api/projects/{$projectId}/uploads", $token, $body, [
            'content-type' => 'multipart/form-data; boundary=' . self::BOUNDARY,
        ]);
    }

    /** @return array<string, string> Workspace storage settings that reach the test RustFS. */
    private function workspaceStorage(): array
    {
        return [...TestServer::s3(), 'region' => 'us-east-1', 'bucket' => TestServer::S3_BUCKET, 'prefix' => 'images'];
    }
}
