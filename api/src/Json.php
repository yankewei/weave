<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;

final class Json
{
    public static function response(mixed $body, int $status = 200): Response
    {
        return new Response(
            $status,
            ['content-type' => 'application/json'],
            self::encode($body),
        );
    }

    // Also how task_events stores task states, so history reads back what the board was sent.
    public static function encode(mixed $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    }

    // The `{statusCode, message}` body the web client reads, as the legacy API sent
    // it. Errors describe one request, so they never go into a cache.
    public static function error(int $status, string $message): Response
    {
        $response = self::response(['statusCode' => $status, 'message' => $message], $status);
        $response->setHeader('cache-control', 'no-store');

        return $response;
    }

    /** @return array<mixed> */
    public static function object(Request $request): array
    {
        try {
            $payload = json_decode($request->getBody()->buffer(), true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiError(400, '请求内容不是有效的 JSON。');
        }
        if (!is_array($payload) || array_is_list($payload)) {
            throw new ApiError(400, '请求内容必须是 JSON 对象。');
        }

        return $payload;
    }
}
