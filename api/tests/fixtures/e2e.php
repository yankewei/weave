<?php

declare(strict_types=1);

require __DIR__ . '/../bootstrap.php';

// Node owns stdin: closing it runs TestServer's normal schema/process cleanup.
$server = \Weave\Api\Tests\TestServer::start($argv[1] ?? '', $argv[2] ?? 'test', $argv[3] ?? \Weave\Api\Tests\TestServer::ORIGIN);
echo $server->url . "\n";
flush();
while (!feof(STDIN)) {
    if (fgets(STDIN) !== false) {
        break;
    }
}
