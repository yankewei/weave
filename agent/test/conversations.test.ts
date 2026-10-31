import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { type ConversationId } from '@earendil-works/pi-durable';
import { Conversations } from '../src/conversations.ts';
import { Admissions, Index, Inputs, State } from '../src/state.ts';
import { type Message } from '../src/protocol.ts';
import { eventually, fixture } from './fixture.ts';

function binding() {
  return {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    ownerId: randomUUID(),
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
  'live message pagination is stable while later turns arrive; import routes are absent',
  { timeout: 20000 },
  async (t) => {
    const app = await fixture(t);
    await app.start();
    const id = randomUUID();
    const path = `/conversations/${id}`;
    await app.request(path, 'PUT', binding());
    for (let turn = 0; turn < 3; turn++) {
      await app.request(`${path}/inputs`, 'POST', input(`问题 ${turn}`));
      await eventually(
        () => app.request(path),
        (state) => state.body.run?.status === 'succeeded',
      );
    }
    let page = (await app.request(`${path}/messages?limit=2`)).body;
    const messages: Message[] = [...page.messages];
    await app.request(`${path}/inputs`, 'POST', input('分页之后的新问题'));
    await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'succeeded',
    );
    while (page.nextCursor) {
      page = (
        await app.request(
          `${path}/messages?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        )
      ).body;
      messages.unshift(...page.messages);
    }
    assert.equal(messages.length, 6);
    assert.equal(new Set(messages.map((message) => message.id)).size, 6);
    assert.deepEqual(
      messages
        .filter((message) => message.authorType === 'user')
        .map((message) => message.body),
      ['问题 0', '问题 1', '问题 2'],
    );
    assert.equal((await app.request(`${path}/import`, 'POST', {})).status, 404);
    assert.equal(
      (await app.request(`${path}/import/complete`, 'POST', {})).status,
      404,
    );
  },
);
