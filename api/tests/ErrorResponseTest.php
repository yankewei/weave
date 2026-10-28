<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use PHPUnit\Framework\TestCase;

final class ErrorResponseTest extends TestCase
{
    private TestServer $server;

    protected function setUp(): void
    {
        $this->server = TestServer::get();
    }

    public function testUnknownRoutesAnswerWithJson(): void
    {
        $response = $this->server->request('GET', '/api/auth/nope');

        self::assertError(404, '接口不存在。', $response);
    }

    public function testWrongMethodsAnswerWithJsonAndTheAllowedMethods(): void
    {
        $response = $this->server->request('GET', '/api/auth/login');

        self::assertError(405, '不支持这个请求方法。', $response);
        self::assertSame('POST', $response->header('allow'));
    }

    public function testAnUnknownRouteDoesNotStallItsKeptAliveConnection(): void
    {
        $unknown = $this->server->request('POST', '/api/nope', str_repeat('x', 4096), ['x-weave-request' => '1']);
        $next = $this->server->request('GET', '/api/auth/session');

        self::assertSame(404, $unknown->status);
        self::assertSame(401, $next->status);
    }

    public function testOversizedBodiesAnswerWithJson(): void
    {
        $response = $this->server->request('POST', '/api/auth/login', str_repeat('x', 1024 * 1024), [
            'content-type' => 'application/json',
            'x-weave-request' => '1',
        ]);

        self::assertError(413, '请求内容过大。', $response);
    }

    public function testErrorsBeforeRoutingAnswerWithJson(): void
    {
        $response = $this->server->request('GET', '/api/auth/session', null, ['x-padding' => str_repeat('x', 64 * 1024)]);

        self::assertError(431, '请求头过大。', $response);
    }

    private static function assertError(int $status, string $message, TestResponse $response): void
    {
        self::assertSame(['statusCode' => $status, 'message' => $message], json_decode($response->body, true));
        self::assertSame($status, $response->status);
        self::assertSame('application/json', $response->header('content-type'));
        self::assertSame('no-store', $response->header('cache-control'));
    }
}
