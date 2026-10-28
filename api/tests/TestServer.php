<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use Amp\Http\Client\HttpClient;
use Amp\Http\Client\HttpClientBuilder;
use Amp\Http\Client\Request;
use Amp\Postgres\PostgresConfig;
use Amp\Postgres\PostgresConnectionPool;

/**
 * Runs bin/server.php as a real process against a throwaway schema with every
 * migration applied, so tests go through routing, middleware and cookies exactly
 * as nginx would. One instance is shared by all tests and torn down at exit.
 *
 * A schema rather than a database keeps the tests runnable for roles without
 * CREATEDB; libpq reads PGOPTIONS, so the server needs no test-only setting.
 */
final class TestServer
{
    public const ORIGIN = 'http://weave.test';

    private static ?self $instance = null;

    /** @var resource */
    private $process;

    private function __construct(
        public readonly PostgresConnectionPool $database,
        private readonly HttpClient $http,
        private readonly string $url,
        private readonly string $log,
    ) {
    }

    public static function get(): self
    {
        return self::$instance ??= self::start();
    }

    /**
     * @param non-empty-string $method
     * @param array<non-empty-string, string> $headers
     */
    public function request(string $method, string $path, ?string $body = null, array $headers = []): TestResponse
    {
        $request = new Request("{$this->url}{$path}", $method, $body ?? '');
        $request->setHeaders($headers);
        $response = $this->http->request($request);

        return new TestResponse($response->getStatus(), $response->getHeaders(), $response->getBody()->buffer());
    }

    private static function start(): self
    {
        $schema = 'weave_test_' . bin2hex(random_bytes(4));
        $options = "-c search_path={$schema}";
        $config = new PostgresConfig(
            host: self::env('POSTGRES_HOST', '127.0.0.1'),
            port: (int) self::env('POSTGRES_PORT', '5432'),
            user: self::env('POSTGRES_USER', 'weave'),
            password: self::env('POSTGRES_PASSWORD'),
            database: self::env('POSTGRES_DB', 'weave'),
            options: $options,
        );
        $database = new PostgresConnectionPool($config);
        try {
            $database->query("CREATE SCHEMA {$schema}");
        } catch (\Throwable $error) {
            throw new \RuntimeException("Cannot prepare Postgres for the API tests ({$error->getMessage()}); start it with `pnpm db:up`.", 0, $error);
        }
        $migrations = glob(__DIR__ . '/../../migrations/*.sql') ?: [];
        sort($migrations);
        foreach ($migrations as $migration) {
            $database->query((string) file_get_contents($migration));
        }

        $port = self::freePort();
        $log = (string) tempnam(sys_get_temp_dir(), 'weave-api-');
        $process = proc_open(
            [PHP_BINARY, __DIR__ . '/../bin/server.php'],
            [0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'w'], 2 => ['file', $log, 'a']],
            $pipes,
            null,
            [
                ...getenv(),
                'API_HOST' => '127.0.0.1',
                'API_PORT' => (string) $port,
                'PGOPTIONS' => $options,
                'AGENT_URL' => 'http://127.0.0.1:9',
                'AGENT_SERVICE_TOKEN' => 'test',
                'APP_ORIGIN' => self::ORIGIN,
                'TRUSTED_PROXY_HOPS' => '1',
            ],
        );
        if ($process === false) {
            throw new \RuntimeException('Cannot start bin/server.php');
        }

        $server = new self($database, HttpClientBuilder::buildDefault(), "http://127.0.0.1:{$port}", $log);
        $server->process = $process;
        register_shutdown_function(static function () use ($server, $schema): void {
            proc_terminate($server->process);
            proc_close($server->process);
            $server->database->query("DROP SCHEMA {$schema} CASCADE");
            $server->database->close();
            @unlink($server->log);
        });
        $server->waitUntilListening($port);

        return $server;
    }

    private function waitUntilListening(int $port): void
    {
        $deadline = microtime(true) + 10;
        while (microtime(true) < $deadline) {
            if (!proc_get_status($this->process)['running']) {
                break;
            }
            $socket = @stream_socket_client("tcp://127.0.0.1:{$port}", timeout: 0.1);
            if ($socket !== false) {
                fclose($socket);

                return;
            }
            usleep(50_000);
        }

        throw new \RuntimeException("bin/server.php did not start:\n" . file_get_contents($this->log));
    }

    private static function freePort(): int
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0');
        if ($socket === false) {
            throw new \RuntimeException('Cannot find a free port');
        }
        $address = (string) stream_socket_get_name($socket, false);
        fclose($socket);

        return (int) substr($address, (int) strrpos($address, ':') + 1);
    }

    private static function env(string $name, ?string $default = null): string
    {
        $value = getenv($name);

        return $value !== false && $value !== '' ? $value : ($default ?? throw new \RuntimeException("Set {$name} for the API tests"));
    }
}
