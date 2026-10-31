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
    public function __construct(private readonly array $payload, string ...$fields)
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

    /**
     * @template T of string
     * @param non-empty-list<T> $values
     * @return T
     */
    public function choice(string $field, array $values): string
    {
        $value = $this->payload[$field] ?? null;
        if (!in_array($value, $values, true)) {
            $this->invalid($field, '必须是 ' . implode('、', $values) . ' 之一');

            return $values[0];
        }

        return $value;
    }

    public function uuidOrNull(string $field): ?string
    {
        $value = $this->payload[$field] ?? null;
        if (($value === null && $this->has($field)) || (is_string($value) && self::isUuid($value))) {
            return $value;
        }
        $this->invalid($field, '必须是有效的标识或 null');

        return null;
    }

    public function positiveInt(string $field): int
    {
        $value = $this->payload[$field] ?? null;
        // json_decode reads 2.0 as a float; zod's int() took any whole number.
        if (is_float($value) && $value === floor($value) && abs($value) <= 2 ** 53) {
            $value = (int) $value;
        }
        if (!is_int($value) || $value < 1) {
            $this->invalid($field, '必须是正整数');

            return 1;
        }

        return $value;
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
