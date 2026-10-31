<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Cookie\CookieAttributes;
use Amp\Http\Cookie\ResponseCookie;
use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Parallel\Worker\WorkerPool;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;
use Amp\Postgres\PostgresQueryError;

/**
 * Sessions live in Postgres; the browser only holds the HttpOnly cookie and the
 * database stores its SHA-256 digest, so a leaked table cannot be replayed.
 *
 * @phpstan-type User array{id: string, name: string, email: string}
 */
final readonly class Auth
{
    private const COOKIE = 'weave_session';
    private const SESSION_AGE = 7 * 24 * 60 * 60;
    private const ATTEMPT_LIMIT = 20;

    // Each derivation holds 32 MiB, so the pool bounds how many run at once.
    public function __construct(
        private PostgresConnectionPool $database,
        private Config $config,
        private WorkerPool $workers,
    ) {
    }

    public function session(Request $request): Response
    {
        return Json::response($this->requireUser($request));
    }

    public function register(Request $request): Response
    {
        // Like legacy, spend the budget before validating so bad payloads are throttled too.
        $this->limitAttempts($this->attemptKey($request));
        $input = self::input($request, withProfile: true);
        $salt = bin2hex(random_bytes(16));
        $key = $this->workers->submit(new DeriveKey($input['password'], $salt))->await();
        try {
            [$user, $token] = Sql::transaction($this->database, function (PostgresExecutor $db) use ($input, $salt, $key): array {
                $user = self::user($db->execute(
                    'INSERT INTO users(id, email, name, password_hash) VALUES(gen_random_uuid(), $1, $2, $3)
                     RETURNING id, name, email',
                    [$input['email'], $input['name'], "{$salt}:{$key}"],
                )->fetchRow() ?? []);
                $workspace = $db->execute(
                    'INSERT INTO workspaces(id, name, created_by) VALUES(gen_random_uuid(), $1, $2) RETURNING id',
                    [$input['workspaceName'], $user['id']],
                )->fetchRow();
                $db->execute(
                    "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1, $2, 'admin')",
                    [Sql::string($workspace, 'id'), $user['id']],
                );

                return [$user, self::createSession($db, $user['id'])];
            });
        } catch (PostgresQueryError $error) {
            if (($error->getDiagnostics()['sqlstate'] ?? null) === '23505') {
                throw new ApiError(409, '这个邮箱已注册，请直接登录。');
            }
            throw $error;
        }

        return $this->withCookie(Json::response($user), $token);
    }

    // Each login reserves an attempt up front so parallel guesses cannot slip
    // past the limit; a correct password hands it back, so only failures add up.
    public function login(Request $request): Response
    {
        $input = self::input($request, withProfile: false);
        $attemptKey = $this->attemptKey($request);
        $this->limitAttempts($attemptKey);
        $account = $this->database->execute(
            'SELECT id, name, email, password_hash FROM users WHERE email = $1',
            [$input['email']],
        )->fetchRow();
        [$salt, $savedKey] = explode(':', $account === null ? '' : Sql::string($account, 'password_hash'), 2) + ['', ''];
        // libsodium only takes 32-byte salts, which is what every stored hash has;
        // anything else fails like an unknown account. Both still derive, so
        // timing does not reveal which accounts exist.
        $valid = $account !== null && strlen($salt) === 32 && $savedKey !== '';
        $key = $this->workers->submit(new DeriveKey($input['password'], $valid ? $salt : str_repeat('0', 32)))->await();
        if (!$valid || !hash_equals($savedKey, $key)) {
            throw new ApiError(401, '邮箱或密码不正确。');
        }
        $user = self::user($account);
        // The cleanup and insert need no atomicity, so skip the BEGIN/COMMIT round trips.
        $token = self::createSession($this->database, $user['id']);
        $this->database->execute(
            'UPDATE auth_attempts SET attempts = attempts - 1 WHERE key = $1 AND attempts > 0',
            [$attemptKey],
        );
        $this->revokeSession($request);

        return $this->withCookie(Json::response($user), $token);
    }

    public function logout(Request $request): Response
    {
        $this->revokeSession($request);

        return $this->withCookie(new Response(204), null);
    }

    /** @return User */
    public function requireUser(Request $request): array
    {
        $token = self::token($request);
        $row = $token === null ? null : $this->database->execute(
            'SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = $1 AND s.expires_at > now()',
            [hash('sha256', $token)],
        )->fetchRow();
        if ($row === null) {
            throw new ApiError(401, '请先登录。');
        }

        return self::user($row);
    }

    private function revokeSession(Request $request): void
    {
        $token = self::token($request);
        if ($token !== null) {
            $this->database->execute('DELETE FROM sessions WHERE token_hash = $1', [hash('sha256', $token)]);
        }
    }

    // Every registration spends the budget, so one address cannot mass-create accounts.
    private function limitAttempts(string $attemptKey): void
    {
        $row = Sql::transaction($this->database, function (PostgresExecutor $db) use ($attemptKey): ?array {
            $db->query('DELETE FROM auth_attempts WHERE resets_at < now()');

            return $db->execute(
                "INSERT INTO auth_attempts(key, attempts, resets_at) VALUES($1, 1, now() + interval '15 minutes')
                 ON CONFLICT(key) DO UPDATE SET attempts = auth_attempts.attempts + 1 RETURNING attempts",
                [$attemptKey],
            )->fetchRow();
        });
        if (($row['attempts'] ?? 0) > self::ATTEMPT_LIMIT) {
            throw new ApiError(429, '登录尝试过多，请 15 分钟后重试。');
        }
    }

    private static function createSession(PostgresExecutor $db, string $userId): string
    {
        $token = bin2hex(random_bytes(32));
        $db->query('DELETE FROM sessions WHERE expires_at <= now()');
        $db->execute(
            'INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, now() + make_interval(secs => $3))',
            [hash('sha256', $token), $userId, self::SESSION_AGE],
        );

        return $token;
    }

    // A null token clears the cookie; amphp drops `Max-Age=0`, so expire it instead.
    private function withCookie(Response $response, ?string $token): Response
    {
        $attributes = CookieAttributes::default()
            ->withPath('/')
            ->withSameSite(CookieAttributes::SAMESITE_LAX);
        if ($this->config->secureCookies) {
            $attributes = $attributes->withSecure();
        }
        $response->setCookie(new ResponseCookie(self::COOKIE, $token ?? '', $token === null
            ? $attributes->withExpiry(new \DateTimeImmutable('@0'))
            : $attributes->withMaxAge(self::SESSION_AGE)));

        return $response;
    }

    // The attempt budget is per client IP; the digest keeps addresses out of the table.
    // nginx appends the address it saw, so only the rightmost entries are
    // trustworthy; anything to their left came from the client. amphp's Forwarded
    // attribute is not used: it skips every private-network address as a proxy,
    // so on a LAN it would pick a client-supplied entry instead.
    private function attemptKey(Request $request): string
    {
        $entries = array_values(array_filter(array_map(
            trim(...),
            explode(',', $request->getHeader('x-forwarded-for') ?? ''),
        )));

        return hash('sha256', $entries[max(0, count($entries) - $this->config->trustedProxyHops)] ?? 'unknown');
    }

    private static function token(Request $request): ?string
    {
        $value = $request->getCookie(self::COOKIE)?->getValue();

        return $value !== null && preg_match('/^[a-f0-9]{64}$/', $value) === 1 ? $value : null;
    }

    /**
     * Mirrors the legacy zod schemas: lower-cased email, trimmed names.
     *
     * @return array{email: string, password: string, name: string, workspaceName: string}
     */
    private static function input(Request $request, bool $withProfile): array
    {
        $fields = $withProfile ? ['email', 'password', 'name', 'workspaceName'] : ['email', 'password'];
        $payload = Input::json($request, ...$fields);
        $input = [
            'email' => $payload->email('email'),
            'password' => $payload->text('password', 12, 128, trim: false),
            'name' => $withProfile ? $payload->text('name', 1, 80) : '',
            'workspaceName' => $withProfile ? $payload->text('workspaceName', 1, 100) : '',
        ];
        $payload->check();

        return $input;
    }

    /**
     * @param array<string, mixed> $row
     * @return User
     */
    private static function user(array $row): array
    {
        return [
            'id' => Sql::string($row, 'id'),
            'name' => Sql::string($row, 'name'),
            'email' => Sql::string($row, 'email'),
        ];
    }
}
