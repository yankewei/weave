<?php

declare(strict_types=1);

namespace Weave\Api\Tests;

use PHPUnit\Framework\TestCase;
use Weave\Api\Config;

final class ConfigTest extends TestCase
{
    private const NAMES = ['APP_ORIGIN', 'COOKIE_SECURE', 'POSTGRES_PASSWORD', 'AGENT_SERVICE_TOKEN'];

    /** @var array<string, string|false> */
    private array $saved = [];

    protected function setUp(): void
    {
        foreach (self::NAMES as $name) {
            $this->saved[$name] = getenv($name);
        }
        // Config::fromEnvironment requires these two; the values do not matter here.
        putenv('POSTGRES_PASSWORD=' . ($this->saved['POSTGRES_PASSWORD'] ?: 'weave'));
        putenv('AGENT_SERVICE_TOKEN=' . ($this->saved['AGENT_SERVICE_TOKEN'] ?: 'test'));
    }

    protected function tearDown(): void
    {
        foreach ($this->saved as $name => $value) {
            self::set($name, $value === false ? null : $value);
        }
    }

    public function testHttpOriginKeepsTheSessionCookieUsableOverPlainHttp(): void
    {
        self::assertFalse($this->config('http://localhost:8080', null)->secureCookies);
    }

    public function testHttpsOriginMarksTheSessionCookieSecure(): void
    {
        self::assertTrue($this->config('https://weave.example', null)->secureCookies);
    }

    public function testAnUnsetOriginDefaultsToSecure(): void
    {
        self::assertTrue($this->config(null, null)->secureCookies);
    }

    public function testCookieSecureOverridesTheOriginScheme(): void
    {
        self::assertTrue($this->config('http://localhost:8080', '1')->secureCookies);
        self::assertFalse($this->config('https://weave.example', '0')->secureCookies);
    }

    public function testAnInvalidOverrideFallsBackToTheOriginScheme(): void
    {
        self::assertFalse($this->config('http://localhost:8080', 'maybe')->secureCookies);
        self::assertTrue($this->config('https://weave.example', 'maybe')->secureCookies);
    }

    private function config(?string $appOrigin, ?string $cookieSecure): Config
    {
        self::set('APP_ORIGIN', $appOrigin);
        self::set('COOKIE_SECURE', $cookieSecure);

        return Config::fromEnvironment();
    }

    private static function set(string $name, ?string $value): void
    {
        if ($value === null) {
            putenv($name);
        } else {
            putenv("{$name}={$value}");
        }
    }
}
