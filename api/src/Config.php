<?php

declare(strict_types=1);

namespace Weave\Api;

final readonly class Config
{
    public function __construct(
        public string $host,
        public int $port,
        public string $postgresHost,
        public int $postgresPort,
        public string $postgresUser,
        public string $postgresPassword,
        public string $postgresDatabase,
        public string $agentUrl,
        public string $agentServiceToken,
    ) {
    }

    public static function fromEnvironment(): self
    {
        return new self(
            host: self::read('API_HOST', '127.0.0.1'),
            port: (int) self::read('API_PORT', '8080'),
            postgresHost: self::read('POSTGRES_HOST', '127.0.0.1'),
            postgresPort: (int) self::read('POSTGRES_PORT', '5432'),
            postgresUser: self::read('POSTGRES_USER', 'weave'),
            postgresPassword: self::read('POSTGRES_PASSWORD'),
            postgresDatabase: self::read('POSTGRES_DB', 'weave'),
            agentUrl: rtrim(self::read('AGENT_URL', 'http://127.0.0.1:8090'), '/'),
            agentServiceToken: self::read('AGENT_SERVICE_TOKEN'),
        );
    }

    private static function read(string $name, ?string $default = null): string
    {
        $value = getenv($name);
        if ($value !== false && $value !== '') {
            return $value;
        }
        if ($default === null) {
            throw new \RuntimeException("Set {$name} in .env");
        }

        return $default;
    }
}
