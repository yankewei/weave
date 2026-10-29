<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

// Signs up fresh accounts and calls the API as them, the way the web client does.
trait WorkspaceClient
{
    // How Sql::iso renders timestamps.
    private const ISO = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/';

    /** @return array{string, string, string, string} Session token, workspace id, user id and email. */
    private function register(string $workspaceName): array
    {
        $email = 'workspace-' . bin2hex(random_bytes(6)) . '@example.com';
        $response = $this->request('POST', '/api/auth/register', null, [
            'email' => $email,
            'password' => 'correct-horse-battery',
            'name' => '测试',
            'workspaceName' => $workspaceName,
        ], ['x-forwarded-for' => '203.0.113.' . random_int(1, 254) . '-' . bin2hex(random_bytes(4))]);
        self::assertSame(200, $response->status);
        $token = self::token($response);
        $userId = self::text(self::json($response), 'id');
        $workspaceId = self::text(self::json($this->request('GET', '/api/workspaces', $token)), 0, 'id');

        return [$token, $workspaceId, $userId, $email];
    }

    /**
     * @param non-empty-string $method
     * @param array<string, mixed>|string|null $body A string is sent as-is, for JSON that json_encode cannot write.
     * @param array<non-empty-string, string> $headers
     */
    private function request(string $method, string $path, ?string $token, array|string|null $body = null, array $headers = []): TestResponse
    {
        return $this->server->request($method, $path, is_array($body) ? (string) json_encode($body) : $body, [
            'content-type' => 'application/json',
            'x-weave-request' => '1',
            ...($token === null ? [] : ['cookie' => "weave_session={$token}"]),
            ...$headers,
        ]);
    }

    private function project(string $token, string $workspaceId, string $name = '项目'): string
    {
        return self::text(self::json($this->request('POST', "/api/workspaces/{$workspaceId}/projects", $token, ['name' => $name])), 'id');
    }

    // Walks decoded JSON or a row, failing the test at the first missing level.
    private static function at(mixed $value, int|string ...$path): mixed
    {
        foreach ($path as $key) {
            self::assertIsArray($value);
            self::assertArrayHasKey($key, $value);
            $value = $value[$key];
        }

        return $value;
    }

    private static function text(mixed $value, int|string ...$path): string
    {
        $value = self::at($value, ...$path);
        self::assertIsString($value);

        return $value;
    }
}
