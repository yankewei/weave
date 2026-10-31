import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Conversations } from './conversations.ts';
import { HttpError, uuid } from './protocol.ts';

const maxBodyBytes = 4 * 1024 * 1024;

async function body(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers['content-type']?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new HttpError(415, '需要 application/json。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) throw new HttpError(413, '请求正文过大。');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 无效。');
  }
}

export function agentServer(runtime: Conversations, serviceToken: string) {
  const expected = Buffer.from(`Bearer ${serviceToken}`);
  return createServer(
    { requestTimeout: 15000, headersTimeout: 15000, maxHeaderSize: 16384 },
    (request, response) => {
      void route(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (!(error instanceof HttpError))
          console.error(
            'Agent request failed',
            error instanceof Error ? error.name : 'unknown',
          );
        response
          .writeHead(error instanceof HttpError ? error.status : 500, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          .end(
            JSON.stringify({
              message:
                error instanceof HttpError ? error.message : 'Agent 请求失败。',
            }),
          );
        request.resume();
      });
    },
  );

  async function route(request: IncomingMessage, response: ServerResponse) {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new HttpError(401, '服务身份无效。');
    const url = new URL(request.url ?? '/', 'http://agent.internal');
    let result: unknown;
    let status = 200;
    if (request.method === 'GET' && url.pathname === '/health') {
      result = { status: 'ok', service: 'weave-agent' };
    } else {
      const match = /^\/conversations\/([^/]+)(.*)$/.exec(url.pathname);
      if (!match) throw new HttpError(404, '接口不存在。');
      const id = uuid(match[1]);
      const suffix = match[2];
      if (request.method === 'PUT' && suffix === '')
        result = await runtime.create(id, await body(request));
      else if (request.method === 'POST' && suffix === '/inputs') {
        result = await runtime.accept(id, await body(request));
        status = 202;
      } else if (request.method === 'GET' && /^\/inputs\/[^/]+$/.test(suffix))
        result = await runtime.receipt(
          id,
          uuid(suffix.slice('/inputs/'.length)),
        );
      else if (
        request.method === 'PUT' &&
        /^\/admissions\/[^/]+\/close$/.test(suffix)
      )
        result = await runtime.closeAdmission(
          id,
          uuid(suffix.split('/')[2]),
          await body(request),
        );
      else if (request.method === 'GET' && suffix === '')
        result = await runtime.snapshot(id);
      else if (request.method === 'GET' && suffix === '/messages') {
        if (
          [...url.searchParams.keys()].some(
            (key) => !['cursor', 'limit'].includes(key),
          ) ||
          url.searchParams.getAll('cursor').length > 1 ||
          url.searchParams.getAll('limit').length > 1
        )
          throw new HttpError(400, '历史查询字段无效。');
        const value = url.searchParams.get('limit') ?? '50';
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 100)
          throw new HttpError(400, '历史页大小无效。');
        result = await runtime.messages(
          id,
          url.searchParams.get('cursor'),
          Number(value),
        );
      } else if (request.method === 'GET' && suffix === '/events') {
        await stream(id, response);
        return;
      } else throw new HttpError(404, '接口不存在。');
    }
    response
      .writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      .end(JSON.stringify(result));
  }

  async function stream(id: string, response: ServerResponse) {
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    const watch = await runtime.watch(id);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (response.destroyed) return;
      const initial = await runtime.snapshot(id);
      if (response.destroyed) return;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      let writing = false;
      const send = async (data: unknown) => {
        if (abort.signal.aborted) return;
        writing = true;
        try {
          if (
            !response.write(
              `event: snapshot\ndata: ${JSON.stringify(data)}\n\n`,
            )
          )
            await once(response, 'drain', { signal: abort.signal });
        } finally {
          writing = false;
        }
      };
      await send(initial);
      watch.start(async () => {
        try {
          await send(await runtime.snapshot(id));
        } catch {
          response.destroy();
        }
      });
      heartbeat = setInterval(() => {
        if (!writing && !response.destroyed && response.writableLength === 0)
          response.write(': heartbeat\n\n');
      }, 15000);
      await Promise.race([
        watch.closed,
        once(response, 'close', { signal: abort.signal }).catch(() => {}),
      ]);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      abort.abort();
      await watch.stop();
      if (!response.destroyed) response.end();
    }
  }
}
