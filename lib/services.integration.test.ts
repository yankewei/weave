import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route handlers depend on the Next request context, so these tests exercise the
// service layer that owns the transactions, SQL and permission rules.

type Services = {
  auth: typeof import('./auth');
  db: typeof import('./db');
  workspaces: typeof import('./services/workspaces');
  documents: typeof import('./services/documents');
  tasks: typeof import('./services/tasks');
  comments: typeof import('./services/comments');
  members: typeof import('./services/members');
  storage: typeof import('./services/storage');
};

let database: EmbeddedPostgres;
let services: Services;
let userId: string;
let workspaceId: string;
let projectId: string;

// Vitest runs with a browser-like import.meta.url, so resolve from the app root.
const directory = join(process.cwd(), 'migrations');

async function migrate(db: typeof import('./db')) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names) {
    const sql = await readFile(`${directory}/${name}`, 'utf8');
    await db.transaction((client) => client.query(sql));
  }
}

beforeAll(async () => {
  const port = 54331;
  database = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), 'weave-unit-')),
    user: 'weave',
    password: 'weave',
    port,
    persistent: false,
  });
  await database.initialise();
  await database.start();
  await database.createDatabase('weave');
  process.env.DATABASE_URL = `postgres://weave:weave@127.0.0.1:${port}/weave`;
  process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  vi.resetModules();
  const db = await import('./db');
  await migrate(db);
  services = {
    auth: await import('./auth'),
    db,
    workspaces: await import('./services/workspaces'),
    documents: await import('./services/documents'),
    tasks: await import('./services/tasks'),
    comments: await import('./services/comments'),
    members: await import('./services/members'),
    storage: await import('./services/storage'),
  };
}, 120_000);

afterAll(async () => {
  await services.db.pool.end().catch(() => undefined);
  await database.stop();
});

describe('services', () => {
  it('registers a user and creates their workspace', async () => {
    const email = `owner-${randomUUID()}@example.com`;
    const result = await services.auth.register({
      email,
      password: 'correct-horse-battery',
      name: 'Owner',
      workspaceName: '空间',
    });
    userId = result.user.id;
    const workspaces = await services.workspaces.listWorkspaces(userId);
    expect(workspaces).toHaveLength(1);
    workspaceId = workspaces[0]!.id;

    const loggedIn = await services.auth.login({
      email,
      password: 'correct-horse-battery',
    });
    expect(loggedIn.user.id).toBe(userId);
    await expect(
      services.auth.login({ email, password: 'wrong-password-here' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('creates a project and keeps documents versioned', async () => {
    const project = await services.workspaces.createProject(
      userId,
      workspaceId,
      { name: '验收项目' },
    );
    projectId = project.id;

    const created = await services.documents.create(userId, projectId, {
      title: '需求',
      body: '第一版',
    });
    expect(created.version).toBe(1);

    const edited = await services.documents.change(userId, created.id, {
      title: '需求',
      body: '第二版',
      baseVersion: 1,
    });
    expect(edited.version).toBe(2);

    await expect(
      services.documents.change(userId, created.id, {
        title: '需求',
        body: '过期写入',
        baseVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const same = await services.documents.change(userId, created.id, {
      title: '需求',
      body: '第二版',
      baseVersion: 2,
    });
    expect(same.version).toBe(2);

    const revisions = await services.documents.revisions(userId, created.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]!.kind).toBe('edit');
  });

  it('records task moves and rejects stale versions', async () => {
    const task = await services.tasks.create(userId, projectId, {
      title: '第一个任务',
      description: '',
      acceptanceCriteria: '',
      status: 'todo',
      priority: 'normal',
      assigneeId: null,
    });
    expect(task.number).toBe(1);

    const moved = await services.tasks.change(userId, task.id, {
      baseVersion: 1,
      status: 'in_progress',
      beforeTaskId: null,
    });
    expect(moved.status).toBe('in_progress');

    await expect(
      services.tasks.change(userId, task.id, {
        baseVersion: 1,
        status: 'done',
        beforeTaskId: null,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const history = await services.tasks.history(userId, task.id);
    expect(history).toHaveLength(2);
  });

  it('allows one-level replies only and limits deletes to authors', async () => {
    const task = await services.tasks.create(userId, projectId, {
      title: '评论任务',
      description: '',
      acceptanceCriteria: '',
      status: 'todo',
      priority: 'low',
      assigneeId: null,
    });
    const root = await services.comments.create(userId, task.id, {
      body: '一级评论',
    });
    const reply = await services.comments.create(userId, task.id, {
      body: '回复',
      parentId: root.id,
    });
    expect(reply.parentId).toBe(root.id);

    await expect(
      services.comments.create(userId, task.id, {
        body: '二级回复',
        parentId: reply.id,
      }),
    ).rejects.toMatchObject({ status: 400 });

    const other = await services.auth.register({
      email: `other-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      name: 'Other',
      workspaceName: '别的空间',
    });
    await expect(
      services.comments.remove(other.user.id, task.id, root.id),
    ).rejects.toMatchObject({ status: 404 });

    await services.comments.remove(userId, task.id, root.id);
    expect(await services.comments.list(userId, task.id)).toHaveLength(0);
  });

  it('invites members and unassigns their tasks on removal', async () => {
    const invitee = await services.auth.register({
      email: `member-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      name: 'Member',
      workspaceName: '成员空间',
    });
    const member = await services.members.invite(
      userId,
      workspaceId,
      invitee.user.email,
    );
    expect(member.role).toBe('member');

    // A plain member cannot manage the roster.
    await expect(
      services.members.invite(
        invitee.user.id,
        workspaceId,
        `another-${randomUUID()}@example.com`,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const task = await services.tasks.create(userId, projectId, {
      title: '指派任务',
      description: '',
      acceptanceCriteria: '',
      status: 'todo',
      priority: 'normal',
      assigneeId: invitee.user.id,
    });
    expect(task.assigneeId).toBe(invitee.user.id);

    const change = await services.members.remove(
      userId,
      workspaceId,
      invitee.user.id,
    );
    expect(change.unassignedTaskCount).toBe(1);

    // The workspace keeps at least one admin.
    await expect(
      services.members.remove(userId, workspaceId, userId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('keeps storage secrets encrypted and hides them from responses', async () => {
    const saved = await services.storage.saveOwn(userId, {
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'weave-bucket',
      prefix: 'weave',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret-value',
    });
    expect(saved.storage?.accessKeyId).toBe('AKIAEXAMPLE');

    const row = await services.db.transaction((client) =>
      client.query<{ secret: string }>(
        'SELECT secret_access_key AS secret FROM user_storage WHERE user_id = $1',
        [userId],
      ),
    );
    expect(row.rows[0]!.secret.startsWith('v1.')).toBe(true);

    const own = await services.storage.readOwn(userId);
    expect(own.storage).not.toHaveProperty('secretAccessKey');

    const shortcut = await services.storage.useAdmin(userId, workspaceId);
    expect(shortcut.shortcut?.userId).toBe(userId);
    expect(shortcut.storage?.accessKeyId).toBe('AKIAEXAMPLE');
  });
});
