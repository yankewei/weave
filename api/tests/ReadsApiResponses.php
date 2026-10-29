<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

trait ReadsApiResponses
{
    /** @return array<mixed> */
    private static function json(TestResponse $response): array
    {
        $body = json_decode($response->body, true, flags: JSON_THROW_ON_ERROR);
        self::assertIsArray($body, $response->body);

        return $body;
    }

    /** The session token a sign-in response set in the `weave_session` cookie. */
    private static function token(TestResponse $response): string
    {
        preg_match('/^weave_session=([a-f0-9]{64});/', $response->header('set-cookie'), $match);

        return $match[1] ?? self::fail('Response did not set a session cookie');
    }
}
