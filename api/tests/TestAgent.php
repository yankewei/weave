<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use Amp\Http\Client\HttpClient;
use Amp\Http\Client\HttpClientBuilder;
use Amp\Http\Client\Request;
use Weave\Api\Json;

final readonly class TestAgent
{
    private function __construct(public string $url, private HttpClient $http)
    {
    }

    public static function start(): self
    {
        $log = (string) tempnam(sys_get_temp_dir(), 'weave-agent-fixture-');
        $process = proc_open(['node', __DIR__ . '/fixtures/agent.mjs'], [0 => ['file', '/dev/null', 'r'], 1 => ['file', $log, 'w'], 2 => ['file', $log, 'a']], $pipes);
        if ($process === false) throw new \RuntimeException('Cannot start the agent fixture');
        register_shutdown_function(static function () use ($process, $log): void { proc_terminate($process); proc_close($process); @unlink($log); });
        $until = microtime(true) + 5;
        do {
            $contents = (string) file_get_contents($log);
            if (preg_match('/listening (\d+)/', $contents, $matches) === 1) return new self('http://127.0.0.1:' . $matches[1], HttpClientBuilder::buildDefault());
            usleep(20_000);
        } while (microtime(true) < $until);

        throw new \RuntimeException('Agent fixture failed: ' . $contents);
    }

    /**
     * @param array<string, mixed> $body
     * @return array<mixed>
     */
    public function control(array $body = []): array
    {
        $request = new Request($this->url . '/control', 'POST', Json::encode($body));
        $request->setHeader('content-type', 'application/json');
        $value = json_decode($this->http->request($request)->getBody()->buffer(), true, flags: JSON_THROW_ON_ERROR);
        if (!is_array($value)) throw new \RuntimeException('Invalid fixture control response');

        return $value;
    }
}
