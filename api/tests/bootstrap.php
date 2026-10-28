<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

// Locally the Postgres credentials live in the repository's .env; CI sets them
// in the environment, which always wins.
$env = __DIR__ . '/../../.env';
if (is_file($env)) {
    foreach (file($env, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        if (preg_match('/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/', $line, $match) === 1 && getenv($match[1]) === false) {
            putenv("{$match[1]}={$match[2]}");
        }
    }
}
