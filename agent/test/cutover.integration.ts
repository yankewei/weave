import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { fixture, eventually, token } from './fixture.ts';

test(
  'PHP + Pi Durable: receive once, disconnect, recover a proposal and confirm exactly once',
  { timeout: 30000 },
  async (t) => {
    const app = await fixture(t);
    await app.start();
    const php = spawn(
      'php',
      ['api/tests/fixtures/cutover.php', app.url, token],
      {
        cwd: new URL('../..', import.meta.url),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let errors = '';
    php.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    php.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    t.after(async () => {
      const exit = once(php, 'exit');
      php.stdin.end();
      await exit;
      assert.equal(php.exitCode, 0, errors);
    });
    await eventually(
      async () => {
        if (php.exitCode !== null) assert.fail(errors);
        return output.trim();
      },
      (url) => url.startsWith('http://'),
    );
    const url = output.trim();
    await app.start({ apiUrl: url });
    let cookie = '';
    const request = async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${url}/api${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Weave-Request': '1',
          cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.headers.has('set-cookie'))
        cookie = response.headers.get('set-cookie')!.split(';')[0];
      assert(
        response.ok,
        `${response.status}: ${await response.clone().text()}`,
      );
      return response.status === 204 ? null : response.json();
    };
    await request('/auth/register', 'POST', {
      email: `cutover-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      name: '切换验证',
      workspaceName: '隔离验证',
    });
    const workspaces = await request('/workspaces');
    const project = await request(
      `/workspaces/${workspaces[0].id}/projects`,
      'POST',
      { name: '持久对话' },
    );
    app.model.toolPlan = [
      {
        name: 'submit_task_proposal',
        arguments: {
          summary: '一个待确认任务',
          tasks: [
            {
              title: '验证切换',
              description: '真实链路',
              acceptanceCriteria: '确认后只创建一次',
              priority: 'normal',
            },
          ],
        },
      },
    ];
    app.model.hold = true;
    const input = { requestId: randomUUID(), body: '拆分一个任务' };
    const path = `/projects/${project.id}/conversation`;
    const accepted = await request(`${path}/messages`, 'POST', input);
    assert.deepEqual(
      await request(`${path}/messages`, 'POST', input),
      accepted,
    );
    await eventually(
      () => request(path),
      (state) => state.conversation?.run?.reply === '已收到',
    );
    const abort = new AbortController();
    const stream = await fetch(
      `${url}/api/conversations/${accepted.conversationId}/events`,
      { headers: { cookie }, signal: abort.signal },
    );
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /event: snapshot/,
    );
    abort.abort();
    await reader.cancel().catch(() => {});
    app.model.release();
    const final = await eventually(
      () => request(path),
      (state) => state.conversation?.run?.syncStatus === 'complete',
    );
    assert.equal(final.conversation.run.status, 'succeeded');
    assert.equal(final.conversation.run.inputStatus, 'accepted');
    assert.equal(
      final.conversation.messages.filter(
        (message: { authorType: string }) => message.authorType === 'user',
      ).length,
      1,
    );
    assert.equal(final.conversation.proposal.status, 'pending');
    const proposal = final.conversation.proposal.id;
    const confirmed = await request(`/proposals/${proposal}/confirm`, 'POST');
    assert.equal(confirmed.proposal.status, 'applied');
    assert.deepEqual(
      await request(`/proposals/${proposal}/confirm`, 'POST'),
      confirmed,
    );
    const tasks = await request(`/projects/${project.id}/tasks`);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, '验证切换');
    assert.equal(app.model.calls, 2);
    assert.equal((await request('/health/ready')).status, 'ok');
  },
);
