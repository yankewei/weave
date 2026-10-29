<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use PHPUnit\Framework\TestCase;

final class AuthTest extends TestCase
{
    use AssertsApiErrors;
    use ReadsApiResponses;

    private const PASSWORD = 'correct-horse-battery';

    private TestServer $server;

    /** Each test gets its own address so login budgets never leak between tests. */
    private string $ip;

    protected function setUp(): void
    {
        $this->server = TestServer::get();
        $this->ip = '198.51.100.' . random_int(1, 254) . '-' . bin2hex(random_bytes(4));
    }

    public function testRegisterCreatesAdminWorkspaceAndSignsIn(): void
    {
        $email = self::email();
        $response = $this->post('/api/auth/register', [
            'email' => strtoupper($email),
            'password' => self::PASSWORD,
            'name' => '  注册者 ',
            'workspaceName' => ' 新空间 ',
        ]);

        self::assertSame(200, $response->status);
        $user = self::json($response);
        self::assertSame(['name' => '注册者', 'email' => $email], ['name' => $user['name'], 'email' => $user['email']]);
        $cookie = $response->header('set-cookie');
        self::assertMatchesRegularExpression('/^weave_session=[a-f0-9]{64};/', $cookie);
        foreach (['Max-Age=604800', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax'] as $attribute) {
            self::assertStringContainsString($attribute, $cookie);
        }
        $membership = $this->server->database->execute(
            'SELECT w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = $1',
            [$user['id']],
        )->fetchRow();
        self::assertSame(['name' => '新空间', 'role' => 'admin'], $membership);
        self::assertSame($user, self::json($this->get('/api/auth/session', self::token($response))));
    }

    public function testRegisterRejectsATakenEmail(): void
    {
        $email = self::email();
        $this->register($email);

        $response = $this->post('/api/auth/register', [
            'email' => $email,
            'password' => self::PASSWORD,
            'name' => '第二个',
            'workspaceName' => '空间',
        ]);

        self::assertError(409, '这个邮箱已注册，请直接登录。', $response);
    }

    public function testLoginAcceptsHashesWrittenByTheLegacyNodeApi(): void
    {
        $email = self::email();
        // scryptSync('written-by-node-scrypt', salt, 64) from node:crypto.
        $this->server->database->execute(
            'INSERT INTO users(id, email, name, password_hash) VALUES(gen_random_uuid(), $1, $2, $3)',
            [$email, '旧用户', '5f1c0e9a7b3d2468ace0bdf13579a2c4:6270357c458eb0593eb26a131234a5ae439481f07f9e5c83be5768493d905fc8ab6240730d71422d0544e6f06472fa523171fbe220baf17518552b64ba3a3477'],
        );

        $response = $this->post('/api/auth/login', ['email' => $email, 'password' => 'written-by-node-scrypt']);

        self::assertSame(200, $response->status);
        self::assertSame('旧用户', self::json($response)['name']);
    }

    public function testLoginRejectsMalformedStoredHashes(): void
    {
        $email = self::email();
        $this->server->database->execute(
            'INSERT INTO users(id, email, name, password_hash) VALUES(gen_random_uuid(), $1, $2, $3)',
            [$email, '坏数据', 'short-salt:'],
        );

        $response = $this->post('/api/auth/login', ['email' => $email, 'password' => self::PASSWORD]);

        self::assertError(401, '邮箱或密码不正确。', $response);
    }

    public function testLoginRejectsWrongPasswordsAndUnknownAccountsAlike(): void
    {
        $email = self::email();
        $this->register($email);

        $wrong = $this->post('/api/auth/login', ['email' => $email, 'password' => 'not-the-password']);
        $unknown = $this->post('/api/auth/login', ['email' => self::email(), 'password' => self::PASSWORD]);

        self::assertError(401, '邮箱或密码不正确。', $wrong);
        self::assertError(401, '邮箱或密码不正确。', $unknown);
    }

    public function testLoginReplacesTheSessionItWasSentWith(): void
    {
        $email = self::email();
        $old = $this->register($email);

        $response = $this->post('/api/auth/login', ['email' => $email, 'password' => self::PASSWORD], $old);

        self::assertSame(200, $response->status);
        self::assertSame(401, $this->get('/api/auth/session', $old)->status);
        self::assertSame(200, $this->get('/api/auth/session', self::token($response))->status);
    }

    public function testLoginOnlySpendsTheBudgetOnFailedAttempts(): void
    {
        $email = self::email();
        $this->register($email);

        for ($i = 0; $i < 25; $i++) {
            self::assertSame(200, $this->post('/api/auth/login', ['email' => $email, 'password' => self::PASSWORD])->status);
        }
        // Registering spent one attempt.
        for ($i = 0; $i < 19; $i++) {
            self::assertSame(401, $this->post('/api/auth/login', ['email' => $email, 'password' => 'not-the-password'])->status);
        }

        $response = $this->post('/api/auth/login', ['email' => $email, 'password' => self::PASSWORD]);

        self::assertError(429, '登录尝试过多，请 15 分钟后重试。', $response);
    }

    public function testLogoutRevokesTheSessionAndExpiresTheCookie(): void
    {
        $token = $this->register(self::email());

        $response = $this->post('/api/auth/logout', null, $token);

        self::assertSame(204, $response->status);
        self::assertStringStartsWith('weave_session=;', $response->header('set-cookie'));
        self::assertStringContainsString('Expires=Thu, 1 Jan 1970', $response->header('set-cookie'));
        self::assertError(401, '请先登录。', $this->get('/api/auth/session', $token));
    }

    public function testSessionRequiresAValidCookie(): void
    {
        self::assertError(401, '请先登录。', $this->get('/api/auth/session'));
        self::assertError(401, '请先登录。', $this->get('/api/auth/session', 'not-a-token'));
        self::assertError(401, '请先登录。', $this->get('/api/auth/session', str_repeat('a', 64)));
    }

    public function testWritesNeedTheCsrfHeaderAndATrustedOrigin(): void
    {
        $body = (string) json_encode(['email' => self::email(), 'password' => self::PASSWORD]);

        $withoutHeader = $this->server->request('POST', '/api/auth/login', $body, ['content-type' => 'application/json']);
        $foreign = $this->server->request('POST', '/api/auth/login', $body, [
            'x-weave-request' => '1',
            'origin' => 'https://evil.example',
        ]);
        $sameOrigin = $this->server->request('POST', '/api/auth/login', $body, [
            'x-weave-request' => '1',
            'origin' => TestServer::ORIGIN,
            'x-forwarded-for' => $this->ip,
        ]);

        self::assertError(403, '请求来源校验失败，请刷新页面后重试。', $withoutHeader);
        self::assertError(403, '请求来源不受信任。', $foreign);
        self::assertError(401, '邮箱或密码不正确。', $sameOrigin);
    }

    public function testARejectedRequestDoesNotStallItsKeptAliveConnection(): void
    {
        $body = (string) json_encode(['email' => self::email(), 'password' => self::PASSWORD]);

        // Rejected before the handler reads the body; the client reuses the connection.
        $rejected = $this->server->request('POST', '/api/auth/login', $body);
        $next = $this->get('/api/auth/session');

        self::assertSame(403, $rejected->status);
        self::assertSame(401, $next->status);
    }

    public function testRejectsMalformedInput(): void
    {
        $invalidJson = $this->server->request('POST', '/api/auth/login', '{nope', ['x-weave-request' => '1']);
        $list = $this->server->request('POST', '/api/auth/login', '[]', ['x-weave-request' => '1']);
        $invalid = $this->post('/api/auth/login', ['email' => 'not-an-email', 'password' => 'short', 'extra' => true]);
        $blankName = $this->post('/api/auth/register', [
            'email' => self::email(),
            'password' => self::PASSWORD,
            'name' => '   ',
            'workspaceName' => '空间',
        ]);

        self::assertError(400, '请求内容不是有效的 JSON。', $invalidJson);
        self::assertError(400, '请求内容必须是 JSON 对象。', $list);
        self::assertError(400, 'extra: 不支持的字段；email: 邮箱格式不正确；password: 长度应为 12–128 个字符', $invalid);
        self::assertError(400, 'name: 长度应为 1–80 个字符', $blankName);
    }

    /** @return string The new session token. */
    private function register(string $email): string
    {
        $response = $this->post('/api/auth/register', [
            'email' => $email,
            'password' => self::PASSWORD,
            'name' => '测试',
            'workspaceName' => '测试空间',
        ]);
        self::assertSame(200, $response->status);

        return self::token($response);
    }

    /** @param array<string, mixed>|null $body */
    private function post(string $path, ?array $body, ?string $token = null): TestResponse
    {
        return $this->server->request('POST', $path, $body === null ? null : (string) json_encode($body), [
            'content-type' => 'application/json',
            'x-weave-request' => '1',
            'x-forwarded-for' => $this->ip,
            ...($token === null ? [] : ['cookie' => "weave_session={$token}"]),
        ]);
    }

    private function get(string $path, ?string $token = null): TestResponse
    {
        return $this->server->request('GET', $path, null, $token === null ? [] : ['cookie' => "weave_session={$token}"]);
    }

    private static function email(): string
    {
        return 'auth-' . bin2hex(random_bytes(6)) . '@example.com';
    }
}
