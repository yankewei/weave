import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';

export const token = 'agent-integration-test-token';

export async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 10000;
  let value: T;
  do {
    value = await read();
    if (check(value)) return value;
    await delay(30);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for state: ${JSON.stringify(value)}`);
}

// Real OpenAI-compatible HTTP stream, with a gate so tests can kill a running agent.
export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'weave-agent-'));
  const pending = new Set<ServerResponse>();
  const model = {
    hold: false,
    calls: 0,
    fail: false,
    toolPlan: [] as { name: string; arguments: unknown }[],
    prompts: [] as unknown[],
    release() {
      this.hold = false;
      for (const response of pending) finish(response);
      pending.clear();
    },
  };
  const finish = (response: ServerResponse) => {
    if (response.destroyed) return;
    response.write(
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '，这是持久回复。' }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  };
  const provider = createServer(async (request, response) => {
    let payload = '';
    for await (const part of request) payload += String(part);
    model.prompts.push(JSON.parse(payload));
    model.calls++;
    if (model.fail) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: { message: 'private-provider-error-and-secret' },
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = model.toolPlan[model.calls - 1];
    if (tool) {
      response.write(
        `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${model.calls}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(
      `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '已收到' }, finish_reason: null }] })}\n\n`,
    );
    if (model.hold) {
      pending.add(response);
      response.once('close', () => pending.delete(response));
    } else finish(response);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert(address && typeof address === 'object');
  let process: ChildProcess | undefined;
  let url = '';
  let log = '';
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (!process || process.exitCode !== null || process.signalCode !== null)
      return;
    const exited = once(process, 'exit');
    process.kill(signal);
    await exited;
  };
  const start = async (options: { key?: string; apiUrl?: string } = {}) => {
    await stop();
    log = '';
    process = spawn(globalThis.process.execPath, ['src/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...globalThis.process.env,
        AGENT_HOST: '127.0.0.1',
        AGENT_PORT: url ? new URL(url).port : '0',
        AGENT_STORAGE_PATH: join(directory, 'agent.sqlite'),
        AGENT_SERVICE_TOKEN: token,
        AGENT_API_URL: options.apiUrl ?? '',
        CMD_API_KEY: options.key ?? 'fake-local-key',
        CMD_MODEL: 'test-model',
        CMD_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout!.on('data', (part) => {
      log += String(part);
    });
    process.stderr!.on('data', (part) => {
      log += String(part);
    });
    await eventually(async () => {
      if (process!.exitCode !== null) assert.fail(log);
      const port = /listening on (\d+)/.exec(log)?.[1];
      if (port) url = `http://127.0.0.1:${port}`;
      return Boolean(port);
    }, Boolean);
  };
  t.after(async () => {
    model.release();
    await stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get url() {
      return url;
    },
    storagePath: join(directory, 'agent.sqlite'),
    start,
    stop,
    model,
    async request(
      path: string,
      method = 'GET',
      value?: unknown,
      authorization = `Bearer ${token}`,
    ) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { authorization, 'content-type': 'application/json' },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json() };
    },
    async stream(path: string) {
      const abort = new AbortController();
      const response = await fetch(`${url}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          'Last-Event-ID': 'obsolete-cursor',
        },
        signal: abort.signal,
      });
      return { response, abort };
    },
    logs: () => log,
    async raw(path: string, payload: string, contentType = 'application/json') {
      const response = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': contentType,
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
