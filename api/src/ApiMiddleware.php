<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\HttpStatus;
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
        $response = null;
        try {
            $response = $this->respond($request, $requestHandler);
            // amphp stops parsing a keep-alive connection until the body is consumed,
            // so a request rejected before reading it would stall the next one.
            $body = $request->getBody();
            while ($body->isReadable() && $body->read() !== null);
        } catch (ClientException $error) {
            // Reading the body hit a server limit such as the size cap. The driver
            // stops parsing and leaves the answer to this handler, so the rest of
            // the body is unreadable and the connection has to close. A handler that
            // answered before the body ran out keeps its answer; otherwise this
            // mirrors the driver's own Http1Driver::sendErrorResponse, which is private.
            $status = $error->getCode();
            $response ??= $this->errorHandler->handleError(
                HttpStatus::isClientError($status) || HttpStatus::isServerError($status) ? $status : 400,
                request: $request,
            );
            $response->setHeader('connection', 'close');
        }
        if (!$response->hasHeader('cache-control')) {
            $response->setHeader('cache-control', 'no-store');
        }

        return $response;
    }

    /** @throws ClientException When reading the body hits a server limit; handleRequest answers it. */
    private function respond(Request $request, RequestHandler $requestHandler): Response
    {
        try {
            $this->assertSameOrigin($request);

            return $requestHandler->handleRequest($request);
        } catch (ClientException $error) {
            throw $error;
        } catch (ApiError $error) {
            return Json::error($error->status, $error->getMessage());
        } catch (PostgresQueryError $error) {
            return match ($error->getDiagnostics()['sqlstate'] ?? null) {
                '23505' => Json::error(409, '数据冲突。'),
                '40P01' => Json::error(409, '数据正在被其他操作处理，请重试。'),
                default => $this->unhandled($error),
            };
        } catch (\Throwable $error) {
            return $this->unhandled($error);
        }
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

        return $this->errorHandler->handleError(500);
    }
}
