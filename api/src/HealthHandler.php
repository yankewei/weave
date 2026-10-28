<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Client\HttpClient;
use Amp\Http\Client\Request as ClientRequest;
use Amp\Http\HttpStatus;
use Amp\Http\Server\Request;
use Amp\Http\Server\RequestHandler;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\TimeoutCancellation;
use Psr\Log\LoggerInterface;

use function Amp\async;

final readonly class HealthHandler implements RequestHandler
{
    public function __construct(
        private PostgresConnectionPool $database,
        private HttpClient $http,
        private Config $config,
        private LoggerInterface $logger,
    ) {
    }

    public function handleRequest(Request $request): Response
    {
        // Both probes run concurrently on the event loop.
        $database = async(fn () => $this->probe('database', function (): void {
            $this->database->query('SELECT 1');
        }));
        $agent = async(fn () => $this->probe('agent', function (): void {
            $request = new ClientRequest("{$this->config->agentUrl}/health");
            $request->setHeader('authorization', "Bearer {$this->config->agentServiceToken}");
            $status = $this->http->request($request)->getStatus();
            if ($status !== HttpStatus::OK) {
                throw new \RuntimeException("agent responded {$status}");
            }
        }));
        $checks = ['database' => $database->await(), 'agent' => $agent->await()];
        $healthy = !in_array('error', $checks, true);

        return new Response(
            $healthy ? HttpStatus::OK : HttpStatus::SERVICE_UNAVAILABLE,
            ['content-type' => 'application/json'],
            json_encode(
                ['status' => $healthy ? 'ok' : 'degraded', 'service' => 'weave-api', ...$checks],
                JSON_THROW_ON_ERROR,
            ),
        );
    }

    /** @param \Closure(): void $check */
    private function probe(string $name, \Closure $check): string
    {
        try {
            async($check)->await(new TimeoutCancellation(2));

            return 'ok';
        } catch (\Throwable $error) {
            $this->logger->warning("{$name} health check failed: {$error->getMessage()}");

            return 'error';
        }
    }
}
