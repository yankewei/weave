<?php

declare(strict_types=1);

namespace Weave\Api;

use Amp\Http\Server\Request;
use Amp\Http\Server\Router;

/**
 * Mirrors the legacy zod schemas: strict keys, and every problem reported at once
 * as `field: message` joined by `；`.
 */
final class Input
{
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';

    /** @var list<string> */
    private array $issues = [];

    /** @param array<mixed> $payload */
    private function __construct(private readonly array $payload, string ...$fields)
    {
        foreach (array_diff(array_map(strval(...), array_keys($payload)), $fields) as $unknown) {
            $this->issues[] = "{$unknown}: 不支持的字段";
        }
    }

    public static function json(Request $request, string ...$fields): self
    {
        return new self(Json::object($request), ...$fields);
    }

    public static function isUuid(string $value): bool
    {
        return preg_match(self::UUID, $value) === 1;
    }

    /** A route parameter that must be an id, as the legacy `uuid()` helper checked it. */
    public static function uuid(Request $request, string $param, string $label): string
    {
        $value = self::param($request, $param);
        if (!self::isUuid($value)) {
            throw new ApiError(400, "{$label} 不是有效的标识。");
        }

        return $value;
    }

    public static function param(Request $request, string $param): string
    {
        $params = $request->getAttribute(Router::class);

        return is_array($params) && is_string($params[$param] ?? null) ? $params[$param] : '';
    }

    public function has(string $field): bool
    {
        return array_key_exists($field, $this->payload);
    }

    public function text(string $field, int $min, int $max, bool $trim = true): string
    {
        $value = $this->payload[$field] ?? null;
        if (!is_string($value)) {
            $this->issues[] = "{$field}: 必须是字符串";

            return '';
        }
        $value = $trim ? trim($value) : $value;
        $length = mb_strlen($value);
        if ($length < $min || $length > $max) {
            $this->issues[] = "{$field}: 长度应为 {$min}–{$max} 个字符";
        }

        return $value;
    }

    public function email(string $field): string
    {
        $email = mb_strtolower($this->text($field, 3, 254, trim: false));
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            $this->invalid($field, '邮箱格式不正确');
        }

        return $email;
    }

    public function invalid(string $field, string $message): void
    {
        $this->issues[] = "{$field}: {$message}";
    }

    public function check(): void
    {
        if ($this->issues !== []) {
            throw new ApiError(400, implode('；', $this->issues));
        }
    }
}
