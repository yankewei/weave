<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Client\HttpException;
use Amp\Http\Server\ClientException;
use Amp\Http\Server\FormParser\Form;
use Amp\Http\Server\HttpErrorException;
use Amp\Http\Server\Request;
use Amp\Http\Server\Response;
use Amp\Postgres\PostgresConnectionPool;
use Amp\Postgres\PostgresExecutor;
use Psr\Log\LoggerInterface;

/**
 * Images pasted into documents. They go to the workspace's own S3 when it has
 * one and to the deployment's default store otherwise (ADR 0003), and are only
 * ever served through /api/uploads/{id} after a membership check.
 */
final class Uploads
{
    public const MAX_BYTES = 4 * 1024 * 1024;
    // Multipart boundaries and part headers on top of the file itself.
    public const MAX_REQUEST_BYTES = self::MAX_BYTES + 64 * 1024;
    // Each upload keeps copies of its image in memory, and a hung store holds them for
    // the store timeout; memory_limit in api/Dockerfile leaves room for this many.
    public const MAX_CONCURRENT_UPLOADS = 16;
    private const EXTENSIONS = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/gif' => 'gif', 'image/webp' => 'webp'];
    private const TOO_LARGE = '图片不能超过 4 MB。';
    private const NO_FILE = '请选择要上传的图片。';

    private int $uploading = 0;

    public function __construct(
        private readonly PostgresConnectionPool $database,
        private readonly Auth $auth,
        private readonly Storage $storage,
        private readonly ?ObjectStore $defaultStore,
        private readonly LoggerInterface $logger,
    ) {
    }

    public function create(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        // Raised first so the middleware's drain ends at the cap, close to the end of
        // the body: a large unread remainder can reset the socket before the reply.
        $request->getBody()->increaseSizeLimit(self::MAX_REQUEST_BYTES);
        if ((int) $request->getHeader('content-length') > self::MAX_REQUEST_BYTES) {
            throw new ApiError(413, self::TOO_LARGE);
        }
        if ($this->uploading >= self::MAX_CONCURRENT_UPLOADS) {
            throw new ApiError(503, '图片上传繁忙，请稍后重试。');
        }
        $this->uploading++;
        try {
            return $this->save($request, $user['id']);
        } finally {
            $this->uploading--;
        }
    }

    private function save(Request $request, string $userId): Response
    {
        $projectId = Workspaces::projectId($request);
        try {
            $file = Form::fromRequest($request)->getFile('file') ?? throw new ApiError(400, self::NO_FILE);
        } catch (HttpErrorException $error) {
            $cause = $error->getPrevious();

            throw $cause instanceof ClientException ? $cause : new ApiError(400, self::NO_FILE);
        }
        $bytes = $file->getContents();
        if ($bytes === '') {
            throw new ApiError(400, '图片是空的。');
        }
        if (strlen($bytes) > self::MAX_BYTES) {
            throw new ApiError(413, self::TOO_LARGE);
        }
        $contentType = self::sniff($bytes) ?? throw new ApiError(400, '只支持 PNG、JPEG、GIF 和 WebP 图片。');
        $fileName = self::cleanName($file->getName());

        $project = $this->database->execute(
            'SELECT p.workspace_id, gen_random_uuid() AS id, ' . Storage::TARGET_COLUMNS . ' FROM projects p
             JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
             LEFT JOIN workspace_storage s ON s.workspace_id = p.workspace_id
             WHERE p.id = $1',
            [$projectId, $userId],
        )->fetchRow() ?? throw new ApiError(404, Workspaces::PROJECT_MISSING);
        $workspaceId = Sql::string($project, 'workspace_id');
        $workspaceStore = $this->storage->target($project);
        $store = $workspaceStore ?? $this->defaultStore ?? throw new ApiError(
            503,
            '尚未配置默认图片存储，无法上传图片。请设置 S3_ENDPOINT 等环境变量，或由管理员配置工作空间的 S3 存储。',
        );
        // The id names the object before the row exists.
        $id = Sql::string($project, 'id');
        $key = ltrim("{$store->prefix}/weave/{$workspaceId}/{$id}." . self::EXTENSIONS[$contentType], '/');

        $unsaved = function (string $outcome, string $detail = '') use ($workspaceStore, $key): ApiError {
            $this->logger->warning("Image store did not save {$key}: {$outcome}");

            return new ApiError(502, $workspaceStore === null
                ? '图片上传到默认存储失败，请稍后重试。'
                : "图片上传到工作空间存储失败{$detail}，请检查存储配置。");
        };
        // The upload runs outside a transaction so a slow store never holds a connection.
        try {
            $status = $store->put($key, $bytes, $contentType);
        } catch (HttpException $error) {
            throw $unsaved($error->getMessage());
        }
        if ($status < 200 || $status >= 300) {
            throw $unsaved("answered {$status}", "（{$status}）");
        }
        try {
            $size = strlen($bytes);
            Sql::transaction($this->database, function (PostgresExecutor $db) use ($id, $workspaceId, $projectId, $userId, $workspaceStore, $key, $contentType, $size, $fileName): void {
                // Membership may have ended while the upload ran.
                Workspaces::project($db, $projectId, $userId, 'SHARE');
                $db->execute(
                    'INSERT INTO uploads(id, workspace_id, project_id, backend, object_key, content_type, size, file_name, uploaded_by)
                     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                    [$id, $workspaceId, $projectId, $workspaceStore === null ? 'default' : 's3', $key, $contentType, $size, $fileName, $userId],
                );
            });
        } catch (\Throwable $error) {
            $store->delete($key);

            throw $error;
        }

        return Json::response(['id' => $id, 'url' => "/api/uploads/{$id}", 'fileName' => $fileName], 201);
    }

    // Every read checks current membership, so the browser may cache only privately
    // and briefly; a removed member loses access once this expires.
    public function read(Request $request): Response
    {
        $user = $this->auth->requireUser($request);
        $upload = $this->database->execute(
            'SELECT u.backend, u.object_key, u.content_type, u.size::text AS size, u.file_name, ' . Storage::TARGET_COLUMNS . '
             FROM uploads u JOIN workspace_members m ON m.workspace_id = u.workspace_id AND m.user_id = $2
             LEFT JOIN workspace_storage s ON s.workspace_id = u.workspace_id AND u.backend = \'s3\'
             WHERE u.id = $1',
            [Input::uuid($request, 'uploadId', '图片'), $user['id']],
        )->fetchRow() ?? throw new ApiError(404, '图片不存在或无权访问。');
        $default = $upload['backend'] === 'default';
        $store = $default
            ? $this->defaultStore ?? throw new ApiError(503, '尚未配置默认图片存储，无法读取图片。')
            : $this->storage->target($upload) ?? throw new ApiError(404, '工作空间已不再使用这张图片所在的存储。');

        $key = Sql::string($upload, 'object_key');
        $unreadable = function (string $outcome) use ($default, $key): ApiError {
            $this->logger->warning("Image store did not return {$key}: {$outcome}");

            return new ApiError(502, $default ? '读取图片失败，请稍后重试。' : '读取工作空间存储失败，请检查存储配置。');
        };
        try {
            $object = $store->get($key);
        } catch (HttpException $error) {
            throw $unreadable($error->getMessage());
        }
        // No Range is sent, so only 200 carries the object.
        if ($object->getStatus() !== 200) {
            $object->getBody()->buffer();

            throw $object->getStatus() === 404 ? new ApiError(404, '图片已不在存储中。') : $unreadable("answered {$object->getStatus()}");
        }

        return new Response(200, [
            'content-type' => Sql::string($upload, 'content_type'),
            'content-length' => $object->getHeader('content-length') ?? Sql::string($upload, 'size'),
            'content-disposition' => "inline; filename*=UTF-8''" . rawurlencode(Sql::string($upload, 'file_name')),
            'cache-control' => 'private, max-age=300',
            'x-content-type-options' => 'nosniff',
            'content-security-policy' => "default-src 'none'; sandbox",
        ], $object->getBody());
    }

    // Trust the bytes, not the browser's declared type; SVG is never accepted.
    private static function sniff(string $bytes): ?string
    {
        return match (true) {
            str_starts_with($bytes, "\x89PNG") => 'image/png',
            str_starts_with($bytes, "\xFF\xD8\xFF") => 'image/jpeg',
            str_starts_with($bytes, 'GIF87a'), str_starts_with($bytes, 'GIF89a') => 'image/gif',
            str_starts_with($bytes, 'RIFF') && substr($bytes, 8, 4) === 'WEBP' => 'image/webp',
            default => null,
        };
    }

    // The name ends up in Markdown alt text, so brackets and control characters go.
    private static function cleanName(string $name): string
    {
        $trimmed = trim((string) preg_replace('/[\p{Cc}\[\]()]/u', '', $name));

        return mb_substr($trimmed === '' ? '图片' : $trimmed, 0, 200);
    }
}
