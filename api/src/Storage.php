<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;

/**
 * A workspace's own S3 bucket for uploaded images, managed by admins. The secret
 * key is stored encrypted and never leaves the server.
 */
final readonly class Storage
{
    private const PUBLIC_COLUMNS = 'endpoint, region, bucket, prefix, access_key_id AS "accessKeyId"';
    // Same envelope as legacy/lib/storage-secret.ts, which still decrypts it for uploads.
    private const SECRET_PREFIX = 'v1.';

    public function __construct(
        private PostgresConnectionPool $database,
        private Auth $auth,
        private Config $config,
    ) {
    }

    public function read(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Workspaces::id($request);
        self::requireAdmin($this->database, $workspaceId, $user['id'], '');

        return Json::response(['storage' => $this->database->execute(
            'SELECT ' . self::PUBLIC_COLUMNS . ' FROM workspace_storage WHERE workspace_id = $1',
            [$workspaceId],
        )->fetchRow()]);
    }

    public function save(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Workspaces::id($request);
        $input = self::input($request);

        return Sql::transaction($this->database, function (PostgresExecutor $db) use ($workspaceId, $user, $input): Response {
            self::requireAdmin($db, $workspaceId, $user['id'], 'FOR UPDATE');
            $current = $db->execute(
                'SELECT secret_access_key FROM workspace_storage WHERE workspace_id = $1 FOR UPDATE',
                [$workspaceId],
            )->fetchRow();
            // A blank secret keeps the saved one; plaintext from before encryption is upgraded.
            $currentSecret = $current === null ? null : Sql::string($current, 'secret_access_key');
            $secret = match (true) {
                $input['secretAccessKey'] !== null => $this->encrypt($input['secretAccessKey']),
                $currentSecret === null => throw new ApiError(400, '请填写访问密钥。'),
                str_starts_with($currentSecret, self::SECRET_PREFIX) => $currentSecret,
                default => $this->encrypt($currentSecret),
            };
            return Json::response(['storage' => $db->execute(
                'INSERT INTO workspace_storage(
                   workspace_id, endpoint, region, bucket, prefix, access_key_id, secret_access_key, updated_by
                 ) VALUES($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (workspace_id) DO UPDATE SET
                   endpoint = EXCLUDED.endpoint,
                   region = EXCLUDED.region,
                   bucket = EXCLUDED.bucket,
                   prefix = EXCLUDED.prefix,
                   access_key_id = EXCLUDED.access_key_id,
                   secret_access_key = EXCLUDED.secret_access_key,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now()
                 RETURNING ' . self::PUBLIC_COLUMNS,
                [
                    $workspaceId,
                    $input['endpoint'],
                    $input['region'],
                    $input['bucket'],
                    $input['prefix'],
                    $input['accessKeyId'],
                    $secret,
                    $user['id'],
                ],
            )->fetchRow()]);
        });
    }

    // Back to the default store; images already in S3 stop resolving.
    public function clear(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $workspaceId = Workspaces::id($request);

        Sql::transaction($this->database, function (PostgresExecutor $db) use ($workspaceId, $user): void {
            self::requireAdmin($db, $workspaceId, $user['id'], 'FOR UPDATE');
            $db->execute('DELETE FROM workspace_storage WHERE workspace_id = $1', [$workspaceId]);
        });

        return Json::response(['storage' => null]);
    }

    // Reads do not need to lock; writes lock only the caller's membership row.
    private static function requireAdmin(PostgresExecutor $db, string $workspaceId, string $userId, string $lock): void
    {
        if (Workspaces::role($db, $workspaceId, $userId, $lock) !== 'admin') {
            throw new ApiError(403, '只有管理员可以设置存储。');
        }
    }

    // AES-256-GCM as `v1.<iv>.<tag>.<ciphertext>`, each part unpadded base64url.
    private function encrypt(string $secret): string
    {
        // Lenient like Node's Buffer.from(…, 'base64'), so keys legacy accepts work here too.
        $key = base64_decode(strtr($this->config->storageEncryptionKey, '-_', '+/'));
        if ($key === '') {
            throw new ApiError(503, '尚未配置 STORAGE_ENCRYPTION_KEY，无法保存存储访问密钥。');
        }
        if (strlen($key) !== 32) {
            throw new ApiError(503, 'STORAGE_ENCRYPTION_KEY 必须是 32 字节的 base64 密钥。');
        }
        $iv = random_bytes(12);
        $ciphertext = openssl_encrypt($secret, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($ciphertext === false) {
            throw new \RuntimeException('Cannot encrypt the storage secret');
        }
        $encode = static fn (string $bytes): string => sodium_bin2base64($bytes, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING);

        return self::SECRET_PREFIX . $encode($iv) . '.' . $encode($tag) . '.' . $encode($ciphertext);
    }

    /**
     * @return array{endpoint: string, region: string, bucket: string, prefix: string, accessKeyId: string, secretAccessKey: ?string}
     */
    private static function input(Request $request): array
    {
        $payload = Input::json($request, 'endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey');
        $endpoint = self::origin($payload->text('endpoint', 1, 300));
        if ($endpoint === null) {
            $payload->invalid('endpoint', '请填写对象存储的服务地址。');
        }
        // The patterns bound the length themselves, so a bad value gets one message.
        $region = $payload->text('region', 0, PHP_INT_MAX);
        if (preg_match('/^[A-Za-z0-9-]{1,64}$/', $region) !== 1) {
            $payload->invalid('region', '请填写存储区域。');
        }
        $bucket = $payload->text('bucket', 0, PHP_INT_MAX);
        if (preg_match('/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/', $bucket) !== 1) {
            $payload->invalid('bucket', '桶名需要使用小写字母、数字和连字符。');
        }
        $prefix = $payload->text('prefix', 0, 200);
        if ($prefix !== '' && (
            preg_match('#^[A-Za-z0-9][A-Za-z0-9/_-]*$#', $prefix) !== 1
            || str_contains($prefix, '..')
            || str_ends_with($prefix, '/')
        )) {
            $payload->invalid('prefix', '目录只能包含字母、数字、斜线和连字符。');
        }
        $accessKeyId = $payload->text('accessKeyId', 1, 128);
        // Blank or absent keeps the saved secret.
        $secret = $payload->has('secretAccessKey') ? trim($payload->text('secretAccessKey', 0, 256, trim: false)) : '';
        $payload->check();

        return [
            'endpoint' => (string) $endpoint,
            'region' => $region,
            'bucket' => $bucket,
            'prefix' => $prefix,
            'accessKeyId' => $accessKeyId,
            'secretAccessKey' => $secret !== '' ? $secret : null,
        ];
    }

    // An http(s) service root without credentials, saved as its WHATWG origin.
    private static function origin(string $endpoint): ?string
    {
        $url = parse_url($endpoint);
        $scheme = strtolower($url['scheme'] ?? '');
        if (
            !in_array($scheme, ['http', 'https'], true)
            || ($url['host'] ?? '') === ''
            || isset($url['user']) || isset($url['pass'])
            || !in_array($url['path'] ?? '/', ['', '/'], true)
            || ($url['query'] ?? '') !== ''
            || ($url['fragment'] ?? '') !== ''
        ) {
            return null;
        }
        $port = $url['port'] ?? null;
        $defaultPort = $scheme === 'https' ? 443 : 80;

        return "{$scheme}://" . strtolower($url['host']) . ($port === null || $port === $defaultPort ? '' : ":{$port}");
    }
}
