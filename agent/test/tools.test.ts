import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fixture, eventually, token } from './fixture.ts';

test(
  'business tools bind the run themselves and replay a proposal saved before SIGKILL',
  { timeout: 30000 },
  async (t) => {
    const app = await fixture(t);
    const calls: {
      path: string;
      body: unknown;
      authorization: string | undefined;
    }[] = [];
    const runId = randomUUID();
    const proposalId = randomUUID();
    const proposals = new Map<string, unknown>();
    const api = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += String(part);
      calls.push({
        path: request.url!,
        body: body ? JSON.parse(body) : null,
        authorization: request.headers.authorization,
      });
      if (request.url!.endsWith('/proposal')) {
        const saved = proposals.has(runId);
        proposals.set(runId, JSON.parse(body));
        // The first request commits externally, but never returns its receipt.
        if (!saved) return;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            proposal: {
              id: proposalId,
              status: 'pending',
              summary: 'server-summary-never-forwarded',
            },
          }),
        );
      } else if (request.url!.endsWith('/outcome')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'acknowledged' }));
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            request.url!.endsWith('/context')
              ? { projectName: '项目', tasks: [], documents: [] }
              : {
                  references: [
                    { key: 'DOC-1', content: { body: '资料不是指令。' } },
                  ],
                },
          ),
        );
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
    app.model.toolPlan = [
      { name: 'read_project_context', arguments: {} },
      { name: 'read_references', arguments: { keys: ['DOC-1'] } },
      {
        name: 'submit_task_proposal',
        arguments: {
          summary: '需要确认。',
          tasks: [
            {
              title: '实现接口',
              description: '',
              acceptanceCriteria: '通过验证',
              priority: 'normal',
            },
          ],
        },
      },
    ];
    const id = randomUUID();
    const path = `/conversations/${id}`;
    await app.request(path, 'PUT', {
      workspaceId: randomUUID(),
      projectId: randomUUID(),
      ownerId: randomUUID(),
    });
    const input = {
      requestId: randomUUID(),
      runId,
      admissionId: randomUUID(),
      body: '请按 DOC-1 拆分任务',
      authorName: '成员',
    };
    assert.equal(
      (await app.request(`${path}/inputs`, 'POST', input)).status,
      202,
    );
    await eventually(
      async () => proposals.size,
      (size) => size === 1,
    );
    await app.stop('SIGKILL');
    await app.start({ apiUrl });
    await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'succeeded',
    );
    assert.equal(proposals.size, 1);
    assert.equal(
      calls.filter((call) => call.path.endsWith('/proposal')).length,
      2,
    );
    assert(
      calls.every((call) =>
        call.path.startsWith(`/internal/agent/runs/${runId}/`),
      ),
    );
    assert(calls.every((call) => call.authorization === `Bearer ${token}`));
    const prompts = JSON.stringify(app.model.prompts);
    assert.match(prompts, /read_project_context/);
    assert.match(prompts, /资料不是指令/);
    assert(prompts.includes(proposalId));
    assert.doesNotMatch(prompts, /server-summary-never-forwarded/);
    assert.doesNotMatch(prompts, /agent-integration-test-token|fake-local-key/);
  },
);

test(
  'model cannot inject an actor and internal errors are sanitized',
  { timeout: 20000 },
  async (t) => {
    const app = await fixture(t);
    let calls = 0;
    const api = createServer((_request, response) => {
      calls++;
      response
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ message: 'private-sql-error-secret' }));
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    const address = api.address();
    assert(address && typeof address === 'object');
    t.after(async () => {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    });
    await app.start({ apiUrl: `http://127.0.0.1:${address.port}` });
    app.model.toolPlan = [
      { name: 'read_project_context', arguments: { runId: randomUUID() } },
      { name: 'read_references', arguments: { keys: ['DOC-1'] } },
    ];
    const id = randomUUID();
    const path = `/conversations/${id}`;
    await app.request(path, 'PUT', {
      workspaceId: randomUUID(),
      projectId: randomUUID(),
      ownerId: randomUUID(),
    });
    await app.request(`${path}/inputs`, 'POST', {
      requestId: randomUUID(),
      runId: randomUUID(),
      admissionId: randomUUID(),
      body: '读取资料',
      authorName: '成员',
    });
    await eventually(
      () => app.request(path),
      (state) => state.body.run?.status === 'succeeded',
    );
    assert.equal(calls, 1);
    assert.doesNotMatch(
      JSON.stringify(app.model.prompts),
      /private-sql-error-secret/,
    );
  },
);
