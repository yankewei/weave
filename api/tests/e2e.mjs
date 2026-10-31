import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

// Stubs the agent health probe; these routes only need the business API.
const agent = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{}');
});
agent.listen(0, '127.0.0.1');
await once(agent, 'listening');
const agentAddress = agent.address();
assert(agentAddress && typeof agentAddress === 'object');
const agentUrl = `http://127.0.0.1:${agentAddress.port}`;

const php = spawn(
  'php',
  ['api/tests/fixtures/e2e.php', agentUrl, 'test'],
  { cwd: new URL('../..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] },
);
let base = '';
let errors = '';
php.stdout.on('data', (chunk) => {
  base += String(chunk);
});
php.stderr.on('data', (chunk) => {
  errors += String(chunk);
});

const stop = async () => {
  if (php.exitCode !== null) return;
  const exit = once(php, 'exit');
  php.stdin.end();
  await exit;
};
process.on('SIGINT', () => void stop());

try {
  const deadline = Date.now() + 15000;
  while (!base.trim().startsWith('http://')) {
    if (php.exitCode !== null) throw new Error(errors);
    if (Date.now() > deadline) throw new Error(`No server URL:\n${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  base = base.trim();

  const email = `e2e-${Date.now()}@example.com`;
  const password = 'correct-horse-battery';
  let cookie = '';
  const call = async (method, path, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') headers['x-weave-request'] = '1';
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length) cookie = setCookie[0].split(';')[0];
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, json, text };
  };
  const expect = (label, actual, wanted) => {
    assert.equal(actual, wanted, `${label}: expected ${wanted}, got ${actual}`);
    console.log(`ok ${label} (${actual})`);
  };

  expect('health', (await call('GET', '/api/health')).status, 200);
  expect('ready', (await call('GET', '/api/health/ready')).status, 200);
  expect(
    'anonymous session',
    (await call('GET', '/api/auth/session')).status,
    401,
  );
  const csrf = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect('csrf blocked', csrf.status, 403);

  const registered = await call('POST', '/api/auth/register', {
    email,
    password,
    name: 'E2E',
    workspaceName: 'E2E 空间',
  });
  expect('register', registered.status, 200);
  expect('session', (await call('GET', '/api/auth/session')).status, 200);

  const workspaces = await call('GET', '/api/workspaces');
  expect('workspaces', workspaces.status, 200);
  expect('workspace count', workspaces.json.length, 1);
  const workspaceId = workspaces.json[0].id;

  const project = await call(
    'POST',
    `/api/workspaces/${workspaceId}/projects`,
    { name: '验收项目' },
  );
  expect('create project', project.status, 201);

  const document = await call(
    'POST',
    `/api/projects/${project.json.id}/documents`,
    { title: '需求', body: '第一版' },
  );
  expect('create document', document.status, 201);
  expect('document version', document.json.version, 1);

  const updated = await call('PUT', `/api/documents/${document.json.id}`, {
    title: '需求',
    body: '第二版',
    baseVersion: 1,
  });
  expect('update document', updated.status, 200);
  expect('document version bumped', updated.json.version, 2);

  const conflict = await call('PUT', `/api/documents/${document.json.id}`, {
    title: '需求',
    body: '旧版本写入',
    baseVersion: 1,
  });
  expect('document conflict', conflict.status, 409);

  const revisions = await call(
    'GET',
    `/api/documents/${document.json.id}/revisions`,
  );
  expect('revisions', revisions.json.length, 2);

  const task = await call('POST', `/api/projects/${project.json.id}/tasks`, {
    title: '第一个任务',
    description: '',
    acceptanceCriteria: '',
    status: 'todo',
    priority: 'normal',
    assigneeId: null,
  });
  expect('create task', task.status, 201);
  expect('task number', task.json.number, 1);

  const moved = await call('POST', `/api/tasks/${task.json.id}/move`, {
    baseVersion: 1,
    status: 'in_progress',
    beforeTaskId: null,
  });
  expect('move task', moved.status, 200);
  expect('move recorded', moved.json.status, 'in_progress');

  const history = await call('GET', `/api/tasks/${task.json.id}/history`);
  expect('task history', history.json.length, 2);

  const comment = await call('POST', `/api/tasks/${task.json.id}/comments`, {
    body: '看起来可以',
  });
  expect('create comment', comment.status, 201);
  const comments = await call('GET', `/api/tasks/${task.json.id}/comments`);
  expect('comments', comments.json.length, 1);

  const conversation = await call(
    'GET',
    `/api/projects/${project.json.id}/conversation`,
  );
  expect('conversation', conversation.status, 200);
  expect('conversation empty', conversation.json.conversation, null);

  const browsed = await call(
    'GET',
    `/api/workspaces/${workspaceId}/browse/DEV-${task.json.number}`,
  );
  expect('browse task', browsed.status, 200);
  expect(
    'browse path',
    browsed.json.path,
    `/workspaces/${workspaceId}/projects/${project.json.id}/board?task=${task.json.id}`,
  );
  expect(
    'browse missing',
    (await call('GET', `/api/workspaces/${workspaceId}/browse/DEV-999`)).status,
    404,
  );

  const taskEvents = await call('GET', `/api/tasks/${task.json.id}/history`);
  if (taskEvents.json[0].after.title !== '第一个任务')
    throw new Error('history payload mismatch');
  console.log('ok history payload');

  await call('POST', '/api/auth/logout');
  expect('logout', (await call('GET', '/api/auth/session')).status, 401);
  console.log('ALL PASSED');
} finally {
  await stop();
  assert.equal(php.exitCode, 0, errors);
  agent.closeAllConnections();
  await new Promise((resolve) => agent.close(() => resolve()));
}
