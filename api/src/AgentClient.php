<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Cancellation;
use Amp\Http\Client\HttpClient;
use Amp\Http\Client\Request;
use Amp\Http\Client\Response;

/** Bounded, authenticated calls to the one configured agent; never follows redirects or retries a POST implicitly. */
final readonly class AgentClient
{
    public function __construct(private HttpClient $http, private Config $config)
    {
    }

    /**
     * @param non-empty-string $method
     * @param array<string, mixed>|null $body
     */
    public function request(string $method, string $path, ?array $body = null, ?Cancellation $cancellation = null, bool $stream = false): Response
    {
        $request = new Request($this->config->agentUrl . $path, $method, $body === null ? '' : Json::encode($body));
        $request->setHeader('authorization', 'Bearer ' . $this->config->agentServiceToken);
        $request->setHeader('content-type', 'application/json');
        $request->setTcpConnectTimeout(2);
        $request->setTransferTimeout($stream ? 0 : 8);
        $request->setInactivityTimeout($stream ? 30 : 8);
        $request->setBodySizeLimit($stream ? 0 : 4 * 1024 * 1024);
        try {
            return $this->http->request($request, $cancellation);
        } catch (\Throwable) {
            throw new ApiError(503, '对话服务暂不可用，请使用原请求标识重试。');
        }
    }

    /**
     * @param non-empty-string $method
     * @param array<string, mixed>|null $body
     * @return array<string, mixed>
     */
    public function json(string $method, string $path, ?array $body = null): array
    {
        $response = $this->request($method, $path, $body);
        if ($response->getStatus() < 200 || $response->getStatus() >= 300) {
            $response->getBody()->close();
            throw new ApiError(match ($response->getStatus()) { 400 => 400, 404 => 404, 409 => 409, default => 503 }, match ($response->getStatus()) {
                400 => '对话请求参数无效。', 404 => '对话服务中不存在该记录。', 409 => '对话正在处理其他请求，或这次接收尝试已经关闭。', default => '对话服务暂不可用，请使用原请求标识重试。',
            });
        }
        try {
            $value = json_decode($response->getBody()->buffer(), true, 32, JSON_THROW_ON_ERROR);
        } catch (\Throwable) {
            throw new ApiError(502, '对话服务返回的内容无效。');
        }
        if (!is_array($value) || array_is_list($value)) {
            throw new ApiError(502, '对话服务返回的内容无效。');
        }

        $result = [];
        foreach ($value as $key => $item) {
            if (!is_string($key)) throw new ApiError(502, '对话服务返回的字段无效。');
            $result[$key] = $item;
        }

        return $result;
    }

    /**
     * @param array<string, mixed> $value
     * @param array<string, mixed> $input
     * @return int
     */
    public static function submission(array $value, string $conversationId, array $input): int
    {
        if (($value['conversationId'] ?? null) !== $conversationId || ($value['requestId'] ?? null) !== $input['requestId']
            || ($value['runId'] ?? null) !== $input['runId'] || ($value['status'] ?? null) !== 'accepted'
            || !is_int($value['submissionId'] ?? null) || $value['submissionId'] < 1) {
            throw new ApiError(502, '对话接收凭据无效。');
        }

        return $value['submissionId'];
    }
}
