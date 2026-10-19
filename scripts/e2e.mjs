import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const databaseDir = mkdtempSync(join(tmpdir(), 'weave-next-'));
const port = 54329;
const base = 'http://127.0.0.1:3100';
const email = `e2e-${Date.now()}@example.com`;
const password = 'correct-horse-battery';

const database = new EmbeddedPostgres({
  databaseDir,
  user: 'weave',
  password: 'weave',
  port,
  persistent: false,
});
await database.initialise();
await database.start();
await database.createDatabase('weave');

const connectionString = `postgres://weave:weave@127.0.0.1:${port}/weave`;
const env = {
  ...process.env,
  DATABASE_URL: connectionString,
  APP_ORIGIN: base,
  NODE_ENV: 'production',
  PORT: '3100',
};

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('exit', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} failed: ${out}`)),
    );
  });
}

const appDirectory = new URL('../', import.meta.url).pathname;
await run('node', ['scripts/migrate.mjs'], appDirectory);
console.log('migrated');

let cookie = '';
async function call(method, path, body, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  };
  if (method !== 'GET') headers['x-weave-request'] = '1';
  if (method !== 'GET') headers.Origin = base;
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
}

function expect(label, actual, wanted) {
  if (actual !== wanted)
    throw new Error(`${label}: expected ${wanted}, got ${actual}`);
  console.log(`ok ${label} (${actual})`);
}

const server = spawn('pnpm', ['exec', 'next', 'start', '-p', '3100'], {
  cwd: appDirectory,
  env,
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
});

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const ready = await fetch(`${base}/api/health/ready`);
      if (ready.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect('health', (await call('GET', '/api/health')).status, 200);
  expect('ready', (await call('GET', '/api/health/ready')).status, 200);
  expect(
    'anonymous session',
    (await call('GET', '/api/auth/session')).status,
    401,
  );
  expect(
    'csrf blocked',
    (
      await (async () => {
        const response = await fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        return { status: response.status };
      })()
    ).status,
    403,
  );

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
    {
      title: '需求',
      body: '第一版',
    },
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

  const page = await fetch(
    `${base}/workspaces/${workspaceId}/projects/${project.json.id}`,
    {
      headers: { Cookie: cookie },
    },
  );
  const html = await page.text();
  expect('project page', page.status, 200);
  if (!html.includes('Weave')) throw new Error('page did not render the shell');
  console.log('ok page renders');

  const taskEvents = await call('GET', `/api/tasks/${task.json.id}/history`);
  if (taskEvents.json[0].after.title !== '第一个任务')
    throw new Error('history payload mismatch');
  console.log('ok history payload');

  await call('POST', '/api/auth/logout');
  expect('logout', (await call('GET', '/api/auth/session')).status, 401);
  console.log('ALL PASSED');
} finally {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  await database.stop();
}
