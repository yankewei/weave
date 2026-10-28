<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

// The `{statusCode, message}` contract the web client relies on for every error.
trait AssertsApiErrors
{
    private static function assertError(int $status, string $message, TestResponse $response): void
    {
        self::assertSame(['statusCode' => $status, 'message' => $message], json_decode($response->body, true));
        self::assertSame($status, $response->status);
        self::assertSame('application/json', $response->header('content-type'));
        self::assertSame('no-store', $response->header('cache-control'));
    }
}
