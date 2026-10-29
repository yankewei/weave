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
use Weave\Api\Comments;
use Weave\Api\Config;
use Weave\Api\HealthHandler;
use Weave\Api\JsonErrorHandler;
use Weave\Api\Members;
use Weave\Api\Storage;
use Weave\Api\Tasks;
use Weave\Api\Workspaces;

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

$workspaces = new Workspaces($database, $auth);
$router->addRoute('GET', '/api/workspaces', new ClosureRequestHandler($workspaces->list(...)));
$router->addRoute('GET', '/api/workspaces/{workspaceId}/projects', new ClosureRequestHandler($workspaces->projects(...)));
$router->addRoute('POST', '/api/workspaces/{workspaceId}/projects', new ClosureRequestHandler($workspaces->createProject(...)));
$router->addRoute('GET', '/api/workspaces/{workspaceId}/overview', new ClosureRequestHandler($workspaces->overview(...)));
$router->addRoute('GET', '/api/workspaces/{workspaceId}/browse/{key}', new ClosureRequestHandler($workspaces->browse(...)));

$members = new Members($database, $auth);
$router->addRoute('GET', '/api/workspaces/{workspaceId}/members', new ClosureRequestHandler($members->list(...)));
$router->addRoute('POST', '/api/workspaces/{workspaceId}/members', new ClosureRequestHandler($members->invite(...)));
$router->addRoute('DELETE', '/api/workspaces/{workspaceId}/members/{userId}', new ClosureRequestHandler($members->remove(...)));

$storage = new Storage($database, $auth, $config);
$router->addRoute('GET', '/api/workspaces/{workspaceId}/storage', new ClosureRequestHandler($storage->read(...)));
$router->addRoute('PUT', '/api/workspaces/{workspaceId}/storage', new ClosureRequestHandler($storage->save(...)));
$router->addRoute('DELETE', '/api/workspaces/{workspaceId}/storage', new ClosureRequestHandler($storage->clear(...)));

$tasks = new Tasks($database, $auth);
$router->addRoute('GET', '/api/projects/{projectId}/tasks', new ClosureRequestHandler($tasks->list(...)));
$router->addRoute('POST', '/api/projects/{projectId}/tasks', new ClosureRequestHandler($tasks->create(...)));
$router->addRoute('GET', '/api/projects/{projectId}/members', new ClosureRequestHandler($tasks->members(...)));
$router->addRoute('PUT', '/api/tasks/{taskId}', new ClosureRequestHandler($tasks->update(...)));
$router->addRoute('POST', '/api/tasks/{taskId}/move', new ClosureRequestHandler($tasks->move(...)));
$router->addRoute('GET', '/api/tasks/{taskId}/history', new ClosureRequestHandler($tasks->history(...)));

$comments = new Comments($database, $auth);
$router->addRoute('GET', '/api/tasks/{taskId}/comments', new ClosureRequestHandler($comments->list(...)));
$router->addRoute('POST', '/api/tasks/{taskId}/comments', new ClosureRequestHandler($comments->create(...)));
$router->addRoute('DELETE', '/api/tasks/{taskId}/comments/{commentId}', new ClosureRequestHandler($comments->remove(...)));

$server->start($router, $errorHandler);

$signal = trapSignal([SIGINT, SIGTERM]);
$logger->info("Received signal {$signal}, stopping");
$server->stop();
$database->close();
