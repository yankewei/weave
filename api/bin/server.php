<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use Amp\ByteStream;
use Amp\Http\Client\HttpClientBuilder;
use Amp\Http\Server\Middleware\ForwardedHeaderType;
use Amp\Http\Server\RequestHandler\ClosureRequestHandler;
use Amp\Http\Server\Router;
use Amp\Http\Server\SocketHttpServer;
use Amp\Log\ConsoleFormatter;
use Amp\Log\StreamHandler;
use Amp\Parallel\Worker\ContextWorkerPool;
use Amp\Postgres\PostgresConfig;
use Amp\Postgres\PostgresConnectionPool;
use Monolog\Logger;
use Monolog\Processor\PsrLogMessageProcessor;
use Weave\Api\ApiMiddleware;
use Weave\Api\Auth;
use Weave\Api\Config;
use Weave\Api\HealthHandler;
use Weave\Api\JsonErrorHandler;

use function Amp\trapSignal;

$config = Config::fromEnvironment();

$logHandler = new StreamHandler(ByteStream\getStdout());
$logHandler->pushProcessor(new PsrLogMessageProcessor());
$logHandler->setFormatter(new ConsoleFormatter());
$logger = new Logger('weave-api');
$logger->pushHandler($logHandler);

$database = new PostgresConnectionPool(new PostgresConfig(
    host: $config->postgresHost,
    port: $config->postgresPort,
    user: $config->postgresUser,
    password: $config->postgresPassword,
    database: $config->postgresDatabase,
));
$http = HttpClientBuilder::buildDefault();

// nginx is the only client; trust its X-Forwarded-For from the private network.
$server = SocketHttpServer::createForBehindProxy(
    $logger,
    ForwardedHeaderType::XForwardedFor,
    ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
);
$server->expose("{$config->host}:{$config->port}");

$errorHandler = new JsonErrorHandler();
$router = new Router($server, $logger, $errorHandler);
$router->addMiddleware(new ApiMiddleware($config, $errorHandler, $logger));
$router->addRoute('GET', '/api/health', new HealthHandler($database, $http, $config, $logger));

// Node's libuv pool ran scrypt on 4 threads; match it.
$auth = new Auth($database, $config, new ContextWorkerPool(4));
$router->addRoute('GET', '/api/auth/session', new ClosureRequestHandler($auth->session(...)));
$router->addRoute('POST', '/api/auth/register', new ClosureRequestHandler($auth->register(...)));
$router->addRoute('POST', '/api/auth/login', new ClosureRequestHandler($auth->login(...)));
$router->addRoute('POST', '/api/auth/logout', new ClosureRequestHandler($auth->logout(...)));

$server->start($router, $errorHandler);

$signal = trapSignal([SIGINT, SIGTERM]);
$logger->info("Received signal {$signal}, stopping");
$server->stop();
$database->close();
