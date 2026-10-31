import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const conversations = new Map();
const closed = new Set();
let mode = '';
let creates = 0;
let accepted = 0;
let disconnected = 0;
const subscriptions = new Set();
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  const input = raw ? JSON.parse(raw) : {};
  const url = new URL(request.url, 'http://fixture');
  const send = (value, status = 200) =>
    response
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify(value));
  if (url.pathname === '/control') {
    if (input.mode !== undefined) mode = input.mode;
    if (input.remove) conversations.delete(input.remove);
    if (input.finish) {
      const conversation = conversations.get(input.finish);
      conversation.run.status = 'succeeded';
      conversation.messages.push({
        id: randomUUID(),
        authorType: 'assistant',
        authorName: null,
        body: '完成讨论，等待确认。',
        createdAt: new Date().toISOString(),
      });
    }
    return send({
      creates,
      accepted,
      disconnected,
      subscriptions: subscriptions.size,
      closed: [...closed],
    });
  }
  if (request.headers.authorization !== 'Bearer test')
    return send({ message: 'unauthorized' }, 401);
  if (url.pathname === '/health') return send({ status: 'ok' });
  const match = /^\/conversations\/([^/]+)(.*)$/.exec(url.pathname);
  if (!match) return send({}, 404);
  const [, id, suffix] = match;
  if (request.method === 'PUT' && suffix === '') {
    if (!conversations.has(id))
      conversations.set(id, {
        binding: input,
        agentConversationId: ++creates,
        messages: [],
        run: null,
        inputs: new Map(),
      });
    return send({
      conversationId: id,
      agentConversationId: conversations.get(id).agentConversationId,
    });
  }
  const conversation = conversations.get(id);
  if (!conversation) return send({}, 404);
  if (request.method === 'POST' && suffix === '/inputs') {
    const previous = conversation.inputs.get(input.requestId);
    if (previous) return send(previous, 202);
    if (closed.has(input.admissionId)) return send({}, 409);
    if (mode === 'before') {
      mode = '';
      return send({}, 503);
    }
    const receipt = {
      conversationId: id,
      requestId: input.requestId,
      runId: input.runId,
      submissionId: ++accepted,
      status: 'accepted',
    };
    conversation.inputs.set(input.requestId, receipt);
    conversation.messages.push({
      id: randomUUID(),
      authorType: 'user',
      authorName: input.authorName,
      body: input.body,
      createdAt: new Date().toISOString(),
    });
    conversation.run = {
      id: input.runId,
      requestId: input.requestId,
      status: 'running',
      reply: '部分回复',
      message: null,
    };
    if (mode === 'after') {
      mode = '';
      return send({}, 503);
    }
    return send(receipt, 202);
  }
  if (request.method === 'GET' && suffix.startsWith('/inputs/')) {
    if (mode === 'unreachable') return send({}, 503);
    const receipt = conversation.inputs.get(suffix.slice('/inputs/'.length));
    return send(receipt ?? {}, receipt ? 200 : 404);
  }
  if (request.method === 'PUT' && suffix.startsWith('/admissions/')) {
    const receipt = conversation.inputs.get(input.requestId);
    if (receipt) return send(receipt);
    closed.add(suffix.split('/')[2]);
    return send({ status: 'closed' });
  }
  const snapshot = {
    conversationId: id,
    messages: conversation.messages,
    nextCursor: null,
    run: conversation.run,
  };
  if (request.method === 'GET' && suffix === '') return send(snapshot);
  if (suffix === '/messages') {
    if (url.searchParams.get('limit') === '0') return send({}, 400);
    return send({ messages: conversation.messages, nextCursor: null });
  }
  if (suffix === '/events') {
    subscriptions.add(response);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    const heartbeat = setInterval(() => {
      if (response.writableLength === 0) response.write(': heartbeat\n\n');
    }, 100);
    response.once('close', () => {
      clearInterval(heartbeat);
      subscriptions.delete(response);
      disconnected++;
    });
    return;
  }
  send({}, 404);
});
server.listen(0, '127.0.0.1', () =>
  console.log(`listening ${server.address().port}`),
);
process.once('SIGTERM', () => {
  server.closeAllConnections();
  server.close();
  process.exit(0);
});
