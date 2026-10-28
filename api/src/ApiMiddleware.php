<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\ClientException;
use Amp\Http\Server\ErrorHandler;
use Amp\Http\Server\Middleware;
use Amp\Http\Server\Request;
use Amp\Http\Server\RequestHandler;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresQueryError;
use Psr\Log\LoggerInterface;

// Every route answers failures with the same JSON shape as the legacy API and
// stays out of shared caches.
final readonly class ApiMiddleware implements Middleware
{
    private const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

    public function __construct(
        private Config $config,
        private ErrorHandler $errorHandler,
        private LoggerInterface $logger,
    ) {
    }

    public function handleRequest(Request $request, RequestHandler $requestHandler): Response
    {
        try {
            $this->assertSameOrigin($request);
            $response = $requestHandler->handleRequest($request);
        } catch (ClientException $error) {
            // Reading the body hit a server limit such as the size cap. The driver
            // stops parsing and leaves the answer to this handler, so the body
            // cannot be drained and the connection has to close.
            $status = $error->getCode() >= 400 && $error->getCode() < 600 ? $error->getCode() : 400;
            $response = $this->errorHandler->handleError($status, request: $request);
            $response->setHeader('connection', 'close');

            return $response;
        } catch (ApiError $error) {
            $response = self::error($error->status, $error->getMessage());
        } catch (PostgresQueryError $error) {
            $response = match ($error->getDiagnostics()['sqlstate'] ?? null) {
                '23505' => self::error(409, '数据冲突。'),
                '40P01' => self::error(409, '数据正在被其他操作处理，请重试。'),
                default => $this->unhandled($error),
            };
        } catch (\Throwable $error) {
            $response = $this->unhandled($error);
        }
        if (!$response->hasHeader('cache-control')) {
            $response->setHeader('cache-control', 'no-store');
        }
        // amphp stops parsing a keep-alive connection until the body is consumed,
        // so a request rejected before reading it would stall the next one.
        $body = $request->getBody();
        while ($body->isReadable() && $body->read() !== null);

        return $response;
    }

    // A non-simple header blocks cross-origin form posts; the Origin check keeps
    // write requests on the same host even when a proxy forwards them.
    private function assertSameOrigin(Request $request): void
    {
        if (in_array($request->getMethod(), self::SAFE_METHODS, true)) {
            return;
        }
        if ($request->getHeader('x-weave-request') !== '1') {
            throw new ApiError(403, '请求来源校验失败，请刷新页面后重试。');
        }
        $origin = $request->getHeader('origin');
        if ($origin === null) {
            return;
        }
        $host = $request->getHeader('host');
        $expected = $this->config->appOrigin !== '' ? self::host($this->config->appOrigin) : $host;
        $actual = self::host($origin);
        if ($actual !== $expected && $actual !== $host) {
            throw new ApiError(403, '请求来源不受信任。');
        }
    }

    // Matches the WHATWG URL `host`: hostname plus any explicit port.
    private static function host(string $url): ?string
    {
        $parts = parse_url($url);
        if (!isset($parts['host'])) {
            return null;
        }

        return isset($parts['port']) ? "{$parts['host']}:{$parts['port']}" : $parts['host'];
    }

    private function unhandled(\Throwable $error): Response
    {
        $this->logger->error('Unhandled API error: {error}', ['error' => $error]);

        return self::error(500, '服务器出错了，请稍后重试。');
    }

    private static function error(int $status, string $message): Response
    {
        return Json::response(['statusCode' => $status, 'message' => $message], $status);
    }
}
