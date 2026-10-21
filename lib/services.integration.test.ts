import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Route handlers depend on the Next request context, so these tests exercise the
// service layer that owns the transactions, SQL and permission rules.

// Object stores are external; keep their contents in memory keyed by bucket.
const objects = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('./object-storage', () => {
  const where = (target: { bucket: string } | null, key: string) =>
    `${target?.bucket ?? 'blob'}:${key}`;
  return {
    putObject: async (
      target: { bucket: string } | null,
      key: string,
      bytes: Uint8Array,
    ) => {
      objects.set(where(target, key), bytes);
    },
    getObject: async (target: { bucket: string } | null, key: string) => {
      const bytes = objects.get(where(target, key));
      return bytes
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          })
        : null;
    },
    deleteObject: async (target: { bucket: string } | null, key: string) => {
      objects.delete(where(target, key));
    },
  };
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Services = {
  auth: typeof import('./auth');
  db: typeof import('./db');
  workspaces: typeof import('./services/workspaces');
  documents: typeof import('./services/documents');
  tasks: typeof import('./services/tasks');
  comments: typeof import('./services/comments');
  members: typeof import('./services/members');
  storage: typeof import('./services/storage');
  uploads: typeof import('./services/uploads');
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
    uploads: await import('./services/uploads'),
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

  it('renumbers a column instead of growing positions without bound', async () => {
    const board = await services.workspaces.createProject(userId, workspaceId, {
      name: '排序项目',
    });
    const add = (title: string) =>
      services.tasks.create(userId, board.id, {
        title,
        description: '',
        acceptanceCriteria: '',
        status: 'done',
        priority: 'normal',
        assigneeId: null,
      });
    const first = await add('首');
    const last = await add('尾');
    const middle: string[] = [];
    // Each move lands right before the last task, halving the same gap every time.
    for (let index = 0; index < 40; index += 1) {
      const task = await services.tasks.create(userId, board.id, {
        title: `中${index}`,
        description: '',
        acceptanceCriteria: '',
        status: 'todo',
        priority: 'normal',
        assigneeId: null,
      });
      await services.tasks.change(userId, task.id, {
        baseVersion: task.version,
        status: 'done',
        beforeTaskId: last.id,
      });
      middle.push(task.id);
    }
    const tasks = await services.tasks.list(userId, board.id);
    expect(tasks.map((task) => task.id)).toEqual([
      first.id,
      ...middle,
      last.id,
    ]);
    for (const task of tasks)
      expect(task.position.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(30);
    // Renumbering moves neighbours without bumping their versions.
    expect(tasks.find((task) => task.id === last.id)!.version).toBe(1);
  });

  it('only spends the login budget on failed attempts', async () => {
    const email = `limit-${randomUUID()}@example.com`;
    await services.auth.register({
      email,
      password: 'correct-horse-battery',
      name: 'Limit',
      workspaceName: '限流空间',
    });
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}-${randomUUID()}`;
    for (let index = 0; index < 25; index += 1)
      await services.auth.loginWithinLimit(ip, {
        email,
        password: 'correct-horse-battery',
      });
    for (let index = 0; index < 20; index += 1)
      await expect(
        services.auth.loginWithinLimit(ip, {
          email,
          password: 'wrong-password-here',
        }),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      services.auth.loginWithinLimit(ip, {
        email,
        password: 'correct-horse-battery',
      }),
    ).rejects.toMatchObject({ status: 429 });
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

  it('uploads images to Vercel Blob by default and serves them to members only', async () => {
    const uploaded = await services.uploads.create(userId, projectId, {
      name: 'shot[1].png',
      bytes: png,
    });
    expect(uploaded.url).toBe(`/api/uploads/${uploaded.id}`);
    expect(uploaded.fileName).toBe('shot1.png');
    expect([...objects.keys()]).toContain(
      `blob:weave/${workspaceId}/${uploaded.id}.png`,
    );

    const opened = await services.uploads.open(userId, uploaded.id);
    expect(opened.contentType).toBe('image/png');
    expect(opened.size).toBe(png.length);

    const outsider = await services.auth.register({
      email: `outsider-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      name: 'Outsider',
      workspaceName: '外部空间',
    });
    await expect(
      services.uploads.open(outsider.user.id, uploaded.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      services.uploads.create(outsider.user.id, projectId, {
        name: 'a.png',
        bytes: png,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // SVG and other declared-as-image bytes are rejected by content, not name.
    await expect(
      services.uploads.create(userId, projectId, {
        name: 'x.png',
        bytes: new TextEncoder().encode('<svg onload="alert(1)"/>'),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('lets admins switch a workspace to its own S3 and back', async () => {
    const invitee = await services.auth.register({
      email: `storage-${randomUUID()}@example.com`,
      password: 'correct-horse-battery',
      name: 'Storage member',
      workspaceName: '存储成员空间',
    });
    await services.members.invite(userId, workspaceId, invitee.user.email);
    const input = {
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'weave-bucket',
      prefix: 'images',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'super-secret-value',
    };
    await expect(
      services.storage.save(invitee.user.id, workspaceId, input),
    ).rejects.toMatchObject({ status: 403 });

    const saved = await services.storage.save(userId, workspaceId, input);
    expect(saved.storage).toEqual({
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'weave-bucket',
      prefix: 'images',
      accessKeyId: 'AKIAEXAMPLE',
    });
    const row = await services.db.transaction((client) =>
      client.query<{ secret: string }>(
        'SELECT secret_access_key AS secret FROM workspace_storage WHERE workspace_id = $1',
        [workspaceId],
      ),
    );
    expect(row.rows[0]!.secret.startsWith('v1.')).toBe(true);

    // Leaving the secret blank keeps the saved one.
    const kept = await services.storage.save(userId, workspaceId, {
      ...input,
      secretAccessKey: undefined,
    });
    expect(kept.storage?.bucket).toBe('weave-bucket');

    const uploaded = await services.uploads.create(invitee.user.id, projectId, {
      name: 'a.png',
      bytes: png,
    });
    expect([...objects.keys()]).toContain(
      `weave-bucket:images/weave/${workspaceId}/${uploaded.id}.png`,
    );
    await expect(
      services.uploads.open(userId, uploaded.id),
    ).resolves.toMatchObject({ contentType: 'image/png' });

    const cleared = await services.storage.clear(userId, workspaceId);
    expect(cleared.storage).toBeNull();
    await expect(
      services.uploads.open(userId, uploaded.id),
    ).rejects.toMatchObject({ status: 404 });
  });
});
