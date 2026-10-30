<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use Amp\Http\Server\Driver\HttpDriver;
use PHPUnit\Framework\TestCase;

final class ErrorResponseTest extends TestCase
{
    use AssertsApiErrors;

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
        $unknown = $this->server->request('POST', '/api/nope', str_repeat('x', 100 * 1024), ['x-weave-request' => '1']);
        $next = $this->server->request('GET', '/api/auth/session');

        self::assertSame(404, $unknown->status);
        self::assertSame(401, $next->status);
    }

    public function testOversizedBodiesAnswerWithJson(): void
    {
        $read = $this->server->request('POST', '/api/auth/login', self::oversizedBody(), [
            'content-type' => 'application/json',
            'x-weave-request' => '1',
        ]);
        // Refused before the body is read: the middleware's drain hits the cap, and
        // the handler's own answer stands.
        $unread = $this->server->request('POST', '/api/auth/login', self::oversizedBody());

        self::assertError(413, '请求内容过大。', $read);
        self::assertError(403, '请求来源校验失败，请刷新页面后重试。', $unread);
        self::assertSame('close', $unread->header('connection'));
    }

    public function testErrorsBeforeRoutingAnswerWithJson(): void
    {
        $response = $this->server->request('GET', '/api/auth/session', null, ['x-padding' => str_repeat('x', 64 * 1024)]);

        self::assertError(431, '请求头过大。', $response);
    }

    // Just over amphp's default body limit, so little is left unread when the
    // server closes; a large remainder can reset the socket before the reply.
    private static function oversizedBody(): string
    {
        return str_repeat('x', HttpDriver::DEFAULT_BODY_SIZE_LIMIT + 1);
    }
}
