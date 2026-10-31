import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { eventually, fixture, token } from './fixture.ts';

test(
  'outcome delivery persists through PHP failure and agent restart without rerunning generation',
  { timeout: 20000 },
  async (t) => {
    const app = await fixture(t);
    let available = false;
    let calls = 0;
    let acknowledged = 0;
    let payload: unknown;
    const runId = randomUUID();
    const api = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      assert.equal(request.url, `/internal/agent/runs/${runId}/outcome`);
      assert.equal(request.method, 'PUT');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      payload = JSON.parse(body);
      calls++;
      if (!available)
        response
          .writeHead(503, { 'content-type': 'application/json' })
          .end('{}');
      else {
        acknowledged++;
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: 'acknowledged' }));
      }
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const address = api.address();
    assert(address && typeof address === 'object');
    const apiUrl = `http://127.0.0.1:${address.port}`;
    t.after(async () => {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    });
    await app.start({ apiUrl });
    const id = randomUUID();
    await app.request(`/conversations/${id}`, 'PUT', {
      workspaceId: randomUUID(),
      projectId: randomUUID(),
      ownerId: randomUUID(),
    });
    const accepted = await app.request(`/conversations/${id}/inputs`, 'POST', {
      requestId: randomUUID(),
      runId,
      admissionId: randomUUID(),
      body: '讨论需求',
      authorName: '成员',
    });
    assert.equal(accepted.status, 202);
    await eventually(
      () => app.request(`/conversations/${id}`),
      (state) => state.body.run?.status === 'succeeded',
    );
    await eventually(
      async () => calls,
      (value) => value >= 1,
    );
    await app.stop('SIGKILL');
    available = true;
    await app.start({ apiUrl });
    await eventually(
      async () => acknowledged,
      (value) => value >= 1,
    );
    assert.deepEqual(payload, {
      status: 'succeeded',
      model: 'test-model',
      error: null,
    });
    assert.equal(app.model.calls, 1);
    // Give the task its commit, then prove a second restart does not redeliver a settled outcome.
    await delay(100);
    await app.stop();
    const settledCalls = calls;
    await app.start({ apiUrl });
    await delay(600);
    assert.equal(calls, settledCalls);
    assert.equal(app.model.calls, 1);
  },
);
