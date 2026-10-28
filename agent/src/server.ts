import { createServer } from 'node:http';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const context = BACKGROUND_CONTEXT;
const port = Number(process.env.AGENT_PORT ?? 8090);
const host = process.env.AGENT_HOST ?? '127.0.0.1';
const storagePath = process.env.AGENT_STORAGE_PATH ?? './data/agent.sqlite';
const serviceToken = process.env.AGENT_SERVICE_TOKEN;
if (!serviceToken) throw new Error('Set AGENT_SERVICE_TOKEN in .env');

// One process owns the storage; conversations left mid-run continue here.
const harness = await Harness.open(
  await openNodeSqliteStorage(storagePath),
  { models: createModels(), registry: createRegistry() },
  context,
);
harness.resume();

const server = createServer((request, response) => {
  // Only the PHP API calls the agent, always with the shared service token.
  if (request.headers.authorization !== `Bearer ${serviceToken}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ status: 'ok', service: 'weave-agent' }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, host, () => {
  console.log(`weave-agent listening on ${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    void harness.close(context).then(() => process.exit(0));
  });
}
