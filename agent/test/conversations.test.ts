import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { type ConversationId } from '@earendil-works/pi-durable';
import { Conversations } from '../src/conversations.ts';
import { Admissions, Index, Inputs, State } from '../src/state.ts';
import { digest, type Message } from '../src/protocol.ts';
import { eventually, fixture } from './fixture.ts';

function binding(importing = false) {
  return {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    ownerId: randomUUID(),
    importing,
  };
}

function input(body = '请帮我澄清需求') {
  return {
    requestId: randomUUID(),
    runId: randomUUID(),
    admissionId: randomUUID(),
    body,
    authorName: '测试成员',
  };
}

test(
  'prepared inputs recover after the pre-submit crash window; closed inputs stay closed',
  { timeout: 30000 },
  async (t) => {
    const app = await fixture(t);
    const runtime = await Conversations.open(app.storagePath, {
      secret: 'fixture',
      mode: 'serve',
    });
    const prepared: { id: string; message: ReturnType<typeof input> }[] = [];
    try {
      for (const closed of [false, true]) {
        const id = randomUUID();
        const message = input();
        await runtime.create(id, binding());
        const index = await runtime.harness.snapshot(Index, context);
        const conversationId = index!.items[id]
          .agentConversationId as ConversationId;
        // Reproduce the durable state left after preparation and before submit(), through Pi's public commit API.
        await runtime.harness.commit(async (tx) => {
          (await tx.doc(State, conversationId)).latestRequestId =
            message.requestId;
          await tx.doc(Inputs, conversationId, message.requestId, {
            ...message,
            messageId: randomUUID(),
            createdAt: new Date().toISOString(),
          });
          await tx.doc(Admissions, conversationId, message.admissionId, {
            requestId: message.requestId,
            runId: message.runId,
            closed,
          });
        }, context);
        prepared.push({ id, message });
      }
    } finally {
      await runtime.harness.close(context);
    }
    await app.start();
    const completed = await eventually(
      () => app.request(`/conversations/${prepared[0].id}`),
      (state) => state.body.run?.status === 'succeeded',
    );
    assert.equal(completed.body.messages.length, 2);
    assert.equal(
      (await app.request(`/conversations/${prepared[1].id}`)).body.run.status,
      'failed',
    );
    assert.equal(
      (
        await app.request(
          `/conversations/${prepared[1].id}/inputs`,
          'POST',
          prepared[1].message,
        )
      ).status,
      409,
    );
    assert.equal(app.model.calls, 1);
  },
);

test(
  'oversized and malformed bodies return HTTP errors; provider errors never reach snapshots',
  { timeout: 20000 },
  async (t) => {
    const app = await fixture(t);
    await app.start();
    const id = randomUUID();
    const path = `/conversations/${id}`;
    await app.request(path, 'PUT', binding());
    assert.equal((await app.raw(`${path}/inputs`, '{')).status, 400);
    assert.equal(
      (await app.raw(`${path}/inputs`, '{}', 'application/json-invalid'))
        .status,
      415,
    );
    assert.equal(
      (
        await app.raw(
          `${path}/inputs`,
          JSON.stringify({ body: 'x'.repeat(4 * 1024 * 1024) }),
        )
      ).status,
      413,
    );
    assert.equal((await app.request('/health')).status, 200);
    app.model.fail = true;
    assert.equal(
      (await app.request(`${path}/inputs`, 'POST', input())).status,
      202,
    );
    const final = await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'failed',
    );
    assert.equal(final.body.messages.length, 1);
    assert.doesNotMatch(
      JSON.stringify(final.body),
      /private-provider-error-and-secret|fake-local-key/,
    );
  },
);

test(
  'authenticated routes validate binding, payloads and model readiness',
  { timeout: 20000 },
  async (t) => {
    const app = await fixture(t);
    await app.start({ key: '' });
    assert.equal(
      (await app.request('/health', 'GET', undefined, '')).status,
      401,
    );
    assert.equal((await app.request('/health')).status, 200);
    const id = randomUUID();
    const owner = binding();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request(`/conversations/${id}`, 'PUT', owner),
      ),
    );
    assert(results.every((result) => result.status === 200));
    assert.equal(
      new Set(results.map((result) => result.body.agentConversationId)).size,
      1,
    );
    assert.equal(
      (await app.request(`/conversations/${id}`, 'PUT', binding())).status,
      409,
    );
    assert.equal(
      (
        await app.request(`/conversations/${id}`, 'PUT', {
          ...owner,
          extra: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (await app.request(`/conversations/${id}/inputs`, 'POST', input()))
        .status,
      503,
    );
    assert.equal(
      (await app.request(`/conversations/${id}/messages?limit=0`)).status,
      400,
    );
    assert.equal(
      (await app.request(`/conversations/${id}/messages?limit=1&limit=2`))
        .status,
      400,
    );
    assert.equal(
      (await app.request(`/conversations/${randomUUID()}`)).status,
      404,
    );
    assert.equal(app.model.calls, 0);
  },
);

test(
  'input deduplication survives restart; SSE disconnect leaves generation running',
  { timeout: 30000 },
  async (t) => {
    const app = await fixture(t);
    await app.start();
    app.model.hold = true;
    const id = randomUUID();
    const path = `/conversations/${id}`;
    const owner = binding();
    await app.request(path, 'PUT', owner);
    const message = input();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.request(`${path}/inputs`, 'POST', message),
      ),
    );
    assert(
      results.every((result) => result.status === 202),
      JSON.stringify(results),
    );
    assert.equal(
      new Set(results.map((result) => result.body.submissionId)).size,
      1,
    );
    assert.equal(
      (
        await app.request(`${path}/inputs`, 'POST', {
          ...message,
          body: '不同内容',
        })
      ).status,
      409,
    );
    assert.equal(
      (await app.request(`${path}/inputs`, 'POST', input())).status,
      409,
    );
    const running = await eventually(
      () => app.request(path),
      (state) => state.body.run?.reply === '已收到',
    );
    assert.equal(running.body.messages.length, 1);
    const stream = await app.stream(`${path}/events`);
    assert.equal(stream.response.status, 200);
    const reader = stream.response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: snapshot/);
    assert.doesNotMatch(first, /fake-local-key|pi\.agent|"toolCall"/);
    stream.abort.abort();
    await reader.cancel().catch(() => {});
    assert.equal((await app.request('/health')).status, 200);
    app.model.release();
    const final = await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'succeeded',
    );
    assert.deepEqual(
      final.body.messages.map((item: Message) => item.body),
      [message.body, '已收到，这是持久回复。'],
    );
    const closed = await app.request(
      `${path}/admissions/${message.admissionId}/close`,
      'PUT',
      { requestId: message.requestId, runId: message.runId },
    );
    assert.equal(closed.body.submissionId, results[0].body.submissionId);
    await app.stop('SIGKILL');
    await app.start();
    const replay = await app.request(`${path}/inputs`, 'POST', message);
    assert.equal(replay.body.submissionId, results[0].body.submissionId);
    assert.deepEqual(
      (await app.request(path)).body.messages,
      final.body.messages,
    );
    const reconnected = await app.stream(`${path}/events`);
    const reconnectedReader = reconnected.response.body!.getReader();
    const recoveredFrame = new TextDecoder().decode(
      (await reconnectedReader.read()).value,
    );
    assert.match(recoveredFrame, /已收到，这是持久回复。/);
    assert.doesNotMatch(recoveredFrame, /^id:/m);
    reconnected.abort.abort();
    await reconnectedReader.cancel().catch(() => {});
    assert.equal(app.model.calls, 1);
  },
);

test(
  'SIGKILL during a committed partial resumes without duplicating the user message',
  { timeout: 30000 },
  async (t) => {
    const app = await fixture(t);
    await app.start();
    app.model.hold = true;
    const id = randomUUID();
    const path = `/conversations/${id}`;
    await app.request(path, 'PUT', binding());
    const message = input();
    const accepted = await app.request(`${path}/inputs`, 'POST', message);
    assert.equal(accepted.status, 202);
    await eventually(
      () => app.request(path),
      (state) => state.body.run?.reply === '已收到',
    );
    await app.stop('SIGKILL');
    await app.start();
    await eventually(
      async () => app.model.calls,
      (calls) => calls >= 2,
    );
    app.model.release();
    const final = await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'succeeded',
    );
    assert.equal(
      final.body.messages.filter(
        (message: Message) => message.authorType === 'user',
      ).length,
      1,
    );
    assert.equal(
      (await app.request(`${path}/inputs/${message.requestId}`)).body
        .submissionId,
      accepted.body.submissionId,
    );
  },
);

test(
  'durable admission fences reject late inputs, including after restart',
  { timeout: 20000 },
  async (t) => {
    const app = await fixture(t);
    await app.start();
    const id = randomUUID();
    const path = `/conversations/${id}`;
    await app.request(path, 'PUT', binding());
    const message = input();
    assert.deepEqual(
      (
        await app.request(
          `${path}/admissions/${message.admissionId}/close`,
          'PUT',
          { requestId: message.requestId, runId: message.runId },
        )
      ).body,
      { status: 'closed' },
    );
    await app.stop('SIGKILL');
    await app.start();
    assert.equal(
      (await app.request(`${path}/inputs`, 'POST', message)).status,
      409,
    );
    assert.equal(
      (
        await app.request(
          `${path}/admissions/${message.admissionId}/close`,
          'PUT',
          { requestId: randomUUID(), runId: message.runId },
        )
      ).status,
      409,
    );
    assert.equal(
      (await app.request(`${path}/inputs/${message.requestId}`)).status,
      404,
    );
    assert.equal(
      (
        await app.request(`${path}/inputs`, 'POST', {
          ...message,
          admissionId: randomUUID(),
        })
      ).status,
      202,
    );
    await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'succeeded',
    );
    assert.equal(app.model.calls, 1);
  },
);

test(
  'ordered history imports are atomic, idempotent, sealed and paginated across restarts',
  { timeout: 30000 },
  async (t) => {
    const app = await fixture(t);
    await app.start({ mode: 'import' });
    const id = randomUUID();
    const path = `/conversations/${id}`;
    const owner = binding(true);
    await app.request(path, 'PUT', owner);
    const messages: Message[] = Array.from({ length: 9 }, (_, index) => ({
      id: randomUUID(),
      authorType: index % 2 ? 'assistant' : 'user',
      authorName: index % 2 ? null : '历史成员',
      body: `历史内容 ${index}`,
      createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
    }));
    const batch = {
      batchId: randomUUID(),
      offset: 0,
      messages: messages.slice(0, 5),
    };
    const first = await app.request(`${path}/import`, 'PUT', batch);
    assert.equal(
      (
        await app.request(`${path}/import`, 'PUT', {
          batchId: randomUUID(),
          offset: 0,
          messages: [{ ...messages[0], authorType: ['user'] }],
        })
      ).status,
      400,
    );
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(first.body.count, 5);
    assert.deepEqual(
      (await app.request(`${path}/import`, 'PUT', batch)).body,
      first.body,
    );
    assert.equal(
      (
        await app.request(`${path}/import`, 'PUT', {
          ...batch,
          messages: messages.slice(0, 4),
        })
      ).status,
      409,
    );
    const invalid = {
      batchId: randomUUID(),
      offset: 5,
      messages: [messages[5], messages[0]],
    };
    assert.equal(
      (await app.request(`${path}/import`, 'PUT', invalid)).status,
      409,
    );
    assert.equal((await app.request(path)).body.messages.length, 5);
    assert.equal(
      (await app.request(`${path}/inputs`, 'POST', input())).status,
      409,
    );
    await app.stop('SIGKILL');
    await app.start();
    assert.equal(
      (await app.request(`${path}/inputs`, 'POST', input())).status,
      409,
    );
    await app.stop();
    await app.start({ mode: 'import' });
    assert.deepEqual(
      (await app.request(`${path}/import`, 'PUT', batch)).body,
      first.body,
    );
    assert.equal(
      (
        await app.request(`${path}/import/complete`, 'PUT', {
          count: 9,
          digest: '0'.repeat(64),
        })
      ).status,
      409,
    );
    const second = await app.request(`${path}/import`, 'PUT', {
      batchId: randomUUID(),
      offset: 5,
      messages: messages.slice(5),
    });
    assert.equal(second.status, 200, JSON.stringify(second));
    let hash = '0'.repeat(64);
    for (const message of messages)
      hash = digest(`${hash}\n${JSON.stringify(message)}`);
    assert.equal(second.body.digest, hash);
    const completion = { count: 9, digest: hash };
    assert.equal(
      (await app.request(`${path}/import/complete`, 'PUT', completion)).status,
      200,
    );
    assert.equal(
      (await app.request(`${path}/import/complete`, 'PUT', completion)).status,
      200,
    );
    assert.equal(
      (
        await app.request(`${path}/import`, 'PUT', {
          batchId: randomUUID(),
          offset: 9,
          messages: [messages[8]],
        })
      ).status,
      409,
    );
    assert.equal(app.model.calls, 0);
    await app.stop();
    await app.start();
    assert.equal(
      (await app.request(path, 'PUT', { ...owner, importing: false })).status,
      200,
    );
    const latest = await app.request(`${path}/messages?limit=3`);
    assert.deepEqual(latest.body.messages, messages.slice(6));
    const cursor = latest.body.nextCursor;
    assert.equal(typeof cursor, 'string');
    assert.equal(
      (await app.request(`${path}/messages?cursor=${cursor}x`)).status,
      400,
    );
    const other = randomUUID();
    await app.request(`/conversations/${other}`, 'PUT', binding());
    assert.equal(
      (await app.request(`/conversations/${other}/messages?cursor=${cursor}`))
        .status,
      400,
    );
    const message = input('新问题');
    assert.equal(
      (await app.request(`${path}/inputs`, 'POST', message)).status,
      202,
    );
    await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'succeeded',
    );
    const older = await app.request(
      `${path}/messages?limit=3&cursor=${cursor}`,
    );
    assert.deepEqual(older.body.messages, messages.slice(3, 6));
    const oldest = await app.request(
      `${path}/messages?limit=3&cursor=${older.body.nextCursor}`,
    );
    assert.deepEqual(oldest.body.messages, messages.slice(0, 3));
    assert.equal(oldest.body.nextCursor, null);
    assert.equal(
      (await app.request(`${path}/import`, 'PUT', batch)).status,
      409,
    );
    assert.match(JSON.stringify(app.model.prompts), /历史内容 0/);
  },
);
