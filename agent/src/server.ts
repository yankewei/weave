import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Conversations } from './conversations.ts';
import { agentServer } from './http.ts';

const port = Number(process.env.AGENT_PORT ?? 8090);
const host = process.env.AGENT_HOST ?? '127.0.0.1';
const storagePath = process.env.AGENT_STORAGE_PATH ?? './data/agent.sqlite';
const serviceToken = process.env.AGENT_SERVICE_TOKEN;
if (!serviceToken?.trim()) throw new Error('Set AGENT_SERVICE_TOKEN in .env');

await mkdir(dirname(storagePath), { recursive: true });
const runtime = await Conversations.open(storagePath, {
  secret: serviceToken,
});
const server = agentServer(runtime, serviceToken);

void runtime.harness.closed.then((result) => {
  if (result.reason !== 'failed') return;
  console.error('Agent storage failed; restart is required');
  server.close();
  server.closeAllConnections();
  process.exit(1);
});

server.listen(port, host, () => {
  const address = server.address();
  console.log(
    `weave-agent listening on ${address && typeof address === 'object' ? address.port : port}`,
  );
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    void runtime.harness.close(BACKGROUND_CONTEXT).then(() => process.exit(0));
  });
}
