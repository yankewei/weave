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
use Weave\Api\AgentTools;
use Weave\Api\AgentClient;
use Weave\Api\Conversations;
use Weave\Api\Auth;
use Weave\Api\Comments;
use Weave\Api\Config;
use Weave\Api\Documents;
use Weave\Api\HealthHandler;
use Weave\Api\JsonErrorHandler;
use Weave\Api\Members;
use Weave\Api\ObjectStore;
use Weave\Api\Proposals;
use Weave\Api\Storage;
use Weave\Api\Tasks;
use Weave\Api\Uploads;
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

// Workspace admins choose the endpoints: a redirect must not lead a read off the
// endpoint or turn a PUT into a GET, and a retry must not multiply the timeouts.
$storeHttp = (new HttpClientBuilder())->followRedirects(0)->retry(0)->build();
$storage = new Storage($database, $auth, $config, $storeHttp);
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

$proposals = new Proposals($database, $auth);
$router->addRoute('GET', '/api/proposals/{proposalId}', new ClosureRequestHandler($proposals->read(...)));
$router->addRoute('POST', '/api/proposals/{proposalId}/{decision}', new ClosureRequestHandler($proposals->resolve(...)));
$router->addRoute('POST', '/internal/agent/runs/{runId}/proposal', new ClosureRequestHandler($proposals->submit(...)));
$agentTools = new AgentTools($database);
$router->addRoute('GET', '/internal/agent/runs/{runId}/context', new ClosureRequestHandler($agentTools->context(...)));
$router->addRoute('POST', '/internal/agent/runs/{runId}/references', new ClosureRequestHandler($agentTools->references(...)));
$router->addRoute('PUT', '/internal/agent/runs/{runId}/outcome', new ClosureRequestHandler($agentTools->outcome(...)));
$conversations = new Conversations($database, $auth, new AgentClient((new HttpClientBuilder())->followRedirects(0)->retry(0)->build(), $config));
$router->addRoute('GET', '/api/projects/{projectId}/conversation', new ClosureRequestHandler($conversations->open(...)));
$router->addRoute('POST', '/api/projects/{projectId}/conversation/messages', new ClosureRequestHandler($conversations->send(...)));
$router->addRoute('GET', '/api/conversations/{conversationId}/messages', new ClosureRequestHandler($conversations->messages(...)));
$router->addRoute('GET', '/api/conversations/{conversationId}/events', new ClosureRequestHandler($conversations->events(...)));

$comments = new Comments($database, $auth);
$router->addRoute('GET', '/api/tasks/{taskId}/comments', new ClosureRequestHandler($comments->list(...)));
$router->addRoute('POST', '/api/tasks/{taskId}/comments', new ClosureRequestHandler($comments->create(...)));
$router->addRoute('DELETE', '/api/tasks/{taskId}/comments/{commentId}', new ClosureRequestHandler($comments->remove(...)));

$documents = new Documents($database, $auth);
$router->addRoute('GET', '/api/projects/{projectId}/documents', new ClosureRequestHandler($documents->list(...)));
$router->addRoute('POST', '/api/projects/{projectId}/documents', new ClosureRequestHandler($documents->create(...)));
$router->addRoute('GET', '/api/documents/{documentId}', new ClosureRequestHandler($documents->read(...)));
$router->addRoute('PUT', '/api/documents/{documentId}', new ClosureRequestHandler($documents->update(...)));
$router->addRoute('POST', '/api/documents/{documentId}/restore', new ClosureRequestHandler($documents->restore(...)));
$router->addRoute('GET', '/api/documents/{documentId}/revisions', new ClosureRequestHandler($documents->revisions(...)));

// The deployment's default image store (ADR 0003).
$defaultStore = null;
if ($config->s3Endpoint !== '') {
    $defaultStore = new ObjectStore(
        $storeHttp,
        ObjectStore::origin($config->s3Endpoint) ?? throw new \RuntimeException('S3_ENDPOINT must be an http(s) origin such as http://rustfs:9000'),
        $config->s3Region,
        $config->s3Bucket,
        $config->s3AccessKeyId,
        $config->s3SecretAccessKey,
    );

    // Create the bucket before serving, briefly: an unreachable store only warns.
    try {
        $status = $defaultStore->createBucket(timeout: 5);
        if ($status !== 200) {
            $logger->warning("Default image store answered {$status} when creating bucket {$config->s3Bucket}");
        }
    } catch (\Throwable $error) {
        $logger->warning("Default image store is unreachable: {$error->getMessage()}");
    }
}

$uploads = new Uploads($database, $auth, $storage, $defaultStore, $logger);
$router->addRoute('POST', '/api/projects/{projectId}/uploads', new ClosureRequestHandler($uploads->create(...)));
$router->addRoute('GET', '/api/uploads/{uploadId}', new ClosureRequestHandler($uploads->read(...)));

$server->start($router, $errorHandler);

$signal = trapSignal([SIGINT, SIGTERM]);
$logger->info("Received signal {$signal}, stopping");
$server->stop();
$database->close();
