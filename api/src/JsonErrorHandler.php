<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\ErrorHandler;
use Amp\Http\Server\Request;
use Amp\Http\Server\Response;

// Errors raised outside ApiMiddleware (unmatched routes, malformed or oversized
// requests) keep the same JSON shape, so the client can always show `message`.
// Callers such as the router add their own headers, e.g. `allow` on 405.
final class JsonErrorHandler implements ErrorHandler
{
    public function handleError(int $status, ?string $reason = null, ?Request $request = null): Response
    {
        $message = match ($status) {
            400 => '请求格式不正确。',
            404 => '接口不存在。',
            405 => '不支持这个请求方法。',
            408 => '请求超时，请重试。',
            413 => '请求内容过大。',
            431 => '请求头过大。',
            503 => '服务暂时不可用，请稍后重试。',
            default => $status < 500 ? '请求无法处理。' : '服务器出错了，请稍后重试。',
        };
        $response = Json::response(['statusCode' => $status, 'message' => $message], $status);
        $response->setHeader('cache-control', 'no-store');

        return $response;
    }
}
