import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApplication } from './bootstrap.js';
import { Test } from '@nestjs/testing';
import EmbeddedPostgres from 'embedded-postgres';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  documentSchema,
  revisionSchema,
  userSchema,
  workspaceSchema,
  projectSchema,
  type Document,
  taskSchema,
  taskEventSchema,
  conversationStateSchema,
  membershipChangeSchema,
  projectMemberSchema,
  workspaceMemberSchema,
  userStorageStateSchema,
  workspaceStorageStateSchema,
  type TaskInput,
} from '@weave/contracts';
import { AppModule } from './app.module.js';
import { Database } from './database.js';
import { migrate } from './migrate.js';
import { CommandCodeTaskProposalModel } from './task-proposal-model.js';

// Real PostgreSQL in an isolated temporary directory; never use a developer's .env database.
describe('authenticated document lifecycle', () => {
  let postgres: EmbeddedPostgres;
  let directory: string;
  let app: NestExpressApplication;
  let database: Database;
  let baseUrl: string;
  let ownerCookie: string;
  let outsiderCookie: string;
  let ownerId: string;
  let workspaceId: string;
  let projectId: string;
  let document: Document;
  const proposalModel = {
    assertReady() {},
    stream: vi.fn(async (): Promise<unknown> => ({
      reply: '还需要补充范围。',
      tasks: [],
    })),
  };

  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = ownerCookie,
    extraHeaders: Record<string, string> = {},
  ) {
    return fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Weave-Request': '1',
        ...(cookie ? { Cookie: cookie } : {}),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function conversationResult(response: Response) {
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream')) return response.json();
    const text = await response.text();
    const done = text
      .split('\n\n')
      .find((block) => block.includes('event: done'));
    const line = done?.split('\n').find((item) => item.startsWith('data: '));
    if (!line) throw new Error(text);
    return JSON.parse(line.slice(6)) as unknown;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'weave-postgres-'));
    const socket = createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, '127.0.0.1', resolve),
    );
    const port = (socket.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    postgres = new EmbeddedPostgres({
      databaseDir: join(directory, 'db'),
      port,
      user: 'postgres',
      password: 'integration-only',
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase('weave_test');
    vi.stubEnv(
      'DATABASE_URL',
      `postgresql://postgres:integration-only@127.0.0.1:${port}/weave_test`,
    );
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CommandCodeTaskProposalModel)
      .useValue(proposalModel)
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configureApplication(app);
    database = app.get(Database);
    await migrate(database);
    await migrate(database); // An already-applied migration is a no-op.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    const owner = await request(
      '/auth/register',
      'POST',
      {
        email: 'owner@example.com',
        password: 'long-test-password',
        name: '负责人',
        workspaceName: '产品团队',
      },
      '',
    );
    expect(owner.status).toBe(201);
    expect(owner.headers.get('set-cookie')).toContain('HttpOnly');
    expect(owner.headers.get('set-cookie')).toContain('SameSite=Lax');
    ownerId = userSchema.parse(await owner.json()).id;
    ownerCookie = owner.headers.get('set-cookie')!.split(';')[0]!;
    const outsider = await request(
      '/auth/register',
      'POST',
      {
        email: 'other@example.com',
        password: 'long-test-password',
        name: '其他用户',
        workspaceName: '另一个团队',
      },
      '',
    );
    expect(outsider.status).toBe(201);
    outsiderCookie = outsider.headers.get('set-cookie')!.split(';')[0]!;
    workspaceId = workspaceSchema
      .array()
      .parse(await (await request('/workspaces')).json())[0]!.id;
    const project = await request(
      `/workspaces/${workspaceId}/projects`,
      'POST',
      { name: '第一步' },
    );
    projectId = projectSchema.parse(await project.json()).id;
  }, 60_000);

  beforeEach(async () => {
    const response = await request(`/projects/${projectId}/documents`, 'POST', {
      title: '需求文档',
      body: '# 第一版\n明确需求。',
    });
    expect(response.status).toBe(201);
    document = documentSchema.parse(await response.json());
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('persists creation, edits and restoration as immutable versions with audit provenance', async () => {
    const edited = await request(`/documents/${document.id}`, 'PUT', {
      title: '确认后的需求',
      body: '# 第二版\n增加验收标准。',
      baseVersion: 1,
    });
    expect(documentSchema.parse(await edited.json()).version).toBe(2);
    const restored = await request(
      `/documents/${document.id}/restore`,
      'POST',
      { baseVersion: 2, revisionVersion: 1 },
    );
    expect(documentSchema.parse(await restored.json())).toMatchObject({
      title: document.title,
      body: document.body,
      version: 3,
    });
    const history = revisionSchema
      .array()
      .parse(
        await (await request(`/documents/${document.id}/revisions`)).json(),
      );
    expect(
      history.map((revision) => [
        revision.version,
        revision.kind,
        revision.restoredFromVersion,
      ]),
    ).toEqual([
      [3, 'restore', 1],
      [2, 'edit', null],
      [1, 'create', null],
    ]);
    const audit = await database.pool.query(
      'SELECT * FROM audit_events WHERE document_id = $1 ORDER BY after_version',
      [document.id],
    );
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows[2]).toMatchObject({
      before_version: 2,
      after_version: 3,
      initiator_id: ownerId,
      confirmer_id: ownerId,
      method: 'restore',
      operation_id: history[0]!.operationId,
    });
  });

  it('accepts the documented maximum body size and rejects oversized content', async () => {
    const body = '文'.repeat(200_000);
    const response = await request(`/documents/${document.id}`, 'PUT', {
      title: document.title,
      body,
      baseVersion: 1,
    });
    expect(response.status).toBe(200);
    expect(documentSchema.parse(await response.json()).body).toBe(body);
    expect(
      (
        await request(`/documents/${document.id}`, 'PUT', {
          title: document.title,
          body: body + '超',
          baseVersion: 2,
        })
      ).status,
    ).toBe(400);
  });

  it('does not add versions for unchanged edits or restoration', async () => {
    const response = await request(`/documents/${document.id}`, 'PUT', {
      title: document.title,
      body: document.body,
      baseVersion: 1,
    });
    expect(documentSchema.parse(await response.json()).version).toBe(1);
    const restored = await request(
      `/documents/${document.id}/restore`,
      'POST',
      { baseVersion: 1, revisionVersion: 1 },
    );
    expect(documentSchema.parse(await restored.json()).version).toBe(1);
    expect(
      await (await request(`/documents/${document.id}/revisions`)).json(),
    ).toHaveLength(1);
  });

  it('allows only one concurrent edit at the same base version', async () => {
    const responses = await Promise.all(
      ['A', 'B'].map((body) =>
        request(`/documents/${document.id}`, 'PUT', {
          title: document.title,
          body,
          baseVersion: 1,
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await (await request(`/documents/${document.id}/revisions`)).json(),
    ).toHaveLength(2);
    expect(
      (
        await request(`/documents/${document.id}/restore`, 'POST', {
          baseVersion: 1,
          revisionVersion: 1,
        })
      ).status,
    ).toBe(409);
  });

  it('rolls back document and snapshot if the audit write fails', async () => {
    await database.pool
      .query(`CREATE FUNCTION test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$;
      CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_reject_audit()`);
    try {
      expect(
        (
          await request(`/documents/${document.id}`, 'PUT', {
            title: '不应保存',
            body: '不应保存',
            baseVersion: 1,
          })
        ).status,
      ).toBe(500);
      const current = documentSchema.parse(
        await (await request(`/documents/${document.id}`)).json(),
      );
      expect(current).toEqual(document);
      expect(
        await (await request(`/documents/${document.id}/revisions`)).json(),
      ).toHaveLength(1);
    } finally {
      await database.pool.query(
        'DROP TRIGGER test_audit_failure ON audit_events; DROP FUNCTION test_reject_audit()',
      );
    }
  });

  it('rejects cross-workspace reads, writes, history, restoration and project access', async () => {
    for (const [path, method, body] of [
      [`/documents/${document.id}`, 'GET', undefined],
      [`/documents/${document.id}/revisions`, 'GET', undefined],
      [
        `/documents/${document.id}`,
        'PUT',
        { title: '越权', body: '', baseVersion: 1 },
      ],
      [
        `/documents/${document.id}/restore`,
        'POST',
        { baseVersion: 1, revisionVersion: 1 },
      ],
      [`/projects/${projectId}/documents`, 'POST', { title: '越权', body: '' }],
      [`/projects/${projectId}/documents`, 'GET', undefined],
      [`/workspaces/${workspaceId}/projects`, 'GET', undefined],
      [`/workspaces/${workspaceId}/projects`, 'POST', { name: '越权' }],
    ] as const)
      expect((await request(path, method, body, outsiderCookie)).status).toBe(
        404,
      );
  });

  it('checks current membership even for an existing session', async () => {
    await database.pool.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, ownerId],
    );
    try {
      expect((await request(`/documents/${document.id}`)).status).toBe(404);
      expect(
        (
          await request(`/documents/${document.id}`, 'PUT', {
            title: '不可修改',
            body: '',
            baseVersion: 1,
          })
        ).status,
      ).toBe(404);
    } finally {
      await database.pool.query(
        "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,'admin')",
        [workspaceId, ownerId],
      );
    }
  });

  it('rejects invalid fields and unknown historical versions without writing', async () => {
    expect(
      (
        await request(`/documents/${document.id}`, 'PUT', {
          title: ' ',
          body: '',
          baseVersion: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/documents/${document.id}`, 'PUT', {
          title: '标题',
          body: '',
          baseVersion: 1,
          workspaceId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/documents/${document.id}/restore`, 'POST', {
          baseVersion: 1,
          revisionVersion: 99,
        })
      ).status,
    ).toBe(404);
    expect((await request('/documents/not-a-uuid')).status).toBe(400);
    expect(
      await (await request(`/documents/${document.id}/revisions`)).json(),
    ).toHaveLength(1);
  });

  it('blocks changes to persisted history at the database level', async () => {
    await expect(
      database.pool.query(
        'UPDATE document_revisions SET body = $1 WHERE document_id = $2',
        ['篡改', document.id],
      ),
    ).rejects.toThrow('History is immutable');
    await expect(
      database.pool.query('DELETE FROM audit_events WHERE document_id = $1', [
        document.id,
      ]),
    ).rejects.toThrow('History is immutable');
  });

  it('rejects unauthenticated and expired sessions', async () => {
    expect(
      (await request(`/documents/${document.id}`, 'GET', undefined, '')).status,
    ).toBe(401);
    const token = 'a'.repeat(64);
    const { createHash } = await import('node:crypto');
    await database.pool.query(
      "INSERT INTO sessions VALUES($1,$2,now() - interval '1 second')",
      [createHash('sha256').update(token).digest('hex'), ownerId],
    );
    expect(
      (
        await request(
          '/auth/session',
          'GET',
          undefined,
          `weave_session=${token}`,
        )
      ).status,
    ).toBe(401);
  });

  it('blocks unsafe origins and missing CSRF headers, including on login', async () => {
    expect(
      (
        await request(
          '/auth/login',
          'POST',
          { email: 'owner@example.com', password: 'long-test-password' },
          '',
          { Origin: 'https://untrusted.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/auth/login',
          'POST',
          { email: 'owner@example.com', password: 'long-test-password' },
          '',
          { 'X-Weave-Request': '' },
        )
      ).status,
    ).toBe(403);
  });

  it('authenticates normalized emails and invalidates sessions on logout', async () => {
    expect(
      (
        await request(
          '/auth/login',
          'POST',
          { email: 'owner@example.com', password: 'incorrect-password' },
          '',
        )
      ).status,
    ).toBe(401);
    const response = await request(
      '/auth/login',
      'POST',
      { email: 'OWNER@example.com', password: 'long-test-password' },
      '',
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    expect(
      (await request('/auth/session', 'GET', undefined, cookie)).status,
    ).toBe(200);
    expect(
      (await request('/auth/logout', 'POST', undefined, cookie)).status,
    ).toBe(204);
    expect(
      (await request('/auth/session', 'GET', undefined, cookie)).status,
    ).toBe(401);
    expect(
      (
        await request(
          '/auth/register',
          'POST',
          {
            email: 'owner@example.com',
            password: 'long-test-password',
            name: '重复',
            workspaceName: '重复',
          },
          '',
        )
      ).status,
    ).toBe(409);
  });

  async function createTask(input: Partial<TaskInput> = {}) {
    const response = await request(`/projects/${projectId}/tasks`, 'POST', {
      title: '实现任务看板',
      description: '支持拖动任务卡片',
      acceptanceCriteria: '刷新后顺序不变',
      status: 'todo',
      priority: 'normal',
      assigneeId: null,
      ...input,
    });
    expect(response.status).toBe(201);
    return taskSchema.parse(await response.json());
  }

  it('creates numbered persisted tasks and records complete field changes', async () => {
    const first = await createTask({ assigneeId: ownerId });
    const second = await createTask();
    expect(second.number).toBe(first.number + 1);
    expect(first.assigneeName).toBe('负责人');
    const editedResponse = await request(`/tasks/${first.id}`, 'PUT', {
      title: '完成看板接口',
      description: '补齐权限与并发校验',
      acceptanceCriteria: '测试全部通过',
      status: 'in_progress',
      priority: 'high',
      assigneeId: null,
      baseVersion: 1,
    });
    expect(editedResponse.status).toBe(200);
    const edited = taskSchema.parse(await editedResponse.json());
    expect(edited).toMatchObject({
      version: 2,
      status: 'in_progress',
      priority: 'high',
      assigneeName: null,
    });
    const history = taskEventSchema
      .array()
      .parse(await (await request(`/tasks/${first.id}/history`)).json());
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      kind: 'edit',
      actorName: '负责人',
      before: { title: first.title, assigneeId: ownerId },
      after: { title: edited.title, assigneeId: null },
    });
    const events = await database.pool.query(
      'SELECT initiator_id, confirmer_id FROM task_events WHERE task_id=$1',
      [first.id],
    );
    expect(
      events.rows.every(
        (event) =>
          event.initiator_id === ownerId && event.confirmer_id === ownerId,
      ),
    ).toBe(true);
    const unchanged = await request(`/tasks/${first.id}`, 'PUT', {
      title: edited.title,
      description: edited.description,
      acceptanceCriteria: edited.acceptanceCriteria,
      status: edited.status,
      priority: edited.priority,
      assigneeId: edited.assigneeId,
      baseVersion: 2,
    });
    expect(taskSchema.parse(await unchanged.json()).version).toBe(2);
  });

  it('persists cross-column movement and relative order without rewriting other task versions', async () => {
    const a = await createTask();
    const b = await createTask();
    const c = await createTask();
    const moved = await request(`/tasks/${c.id}/move`, 'POST', {
      status: 'todo',
      beforeTaskId: a.id,
      baseVersion: 1,
    });
    expect(moved.status).toBe(201);
    const list = taskSchema
      .array()
      .parse(await (await request(`/projects/${projectId}/tasks`)).json());
    expect(
      list
        .filter((task) => [a.id, b.id, c.id].includes(task.id))
        .map((task) => task.id),
    ).toEqual([c.id, a.id, b.id]);
    expect(list.find((task) => task.id === a.id)?.version).toBe(1);
    const next = await request(`/tasks/${c.id}/move`, 'POST', {
      status: 'done',
      beforeTaskId: null,
      baseVersion: 2,
    });
    expect(taskSchema.parse(await next.json())).toMatchObject({
      status: 'done',
      version: 3,
    });
    const unchanged = await request(`/tasks/${c.id}/move`, 'POST', {
      status: 'done',
      beforeTaskId: null,
      baseVersion: 3,
    });
    expect(taskSchema.parse(await unchanged.json()).version).toBe(3);
    const history = taskEventSchema
      .array()
      .parse(await (await request(`/tasks/${c.id}/history`)).json());
    expect(history.map((event) => event.kind)).toEqual([
      'move',
      'move',
      'create',
    ]);
    expect(history[1]!.before?.position).not.toBe(history[1]!.after.position);
  });

  it('keeps distinct ranks after repeated insertion into a narrowing gap', async () => {
    const left = await createTask();
    const right = await createTask();
    let moving = await createTask();
    let anchor = right;
    for (let index = 0; index < 90; index++) {
      const response = await request(`/tasks/${moving.id}/move`, 'POST', {
        status: 'todo',
        beforeTaskId: anchor.id,
        baseVersion: moving.version,
      });
      expect(response.status).toBe(201);
      const updated = taskSchema.parse(await response.json());
      moving = anchor;
      anchor = updated;
    }
    const ranks = await database.pool.query(
      'SELECT count(DISTINCT position)::int AS count FROM tasks WHERE id = ANY($1::uuid[])',
      [[left.id, right.id, moving.id, anchor.id]],
    );
    expect(ranks.rows[0].count).toBe(3);
  });

  it('serializes concurrent task moves and rejects a stale edit', async () => {
    const task = await createTask();
    const responses = await Promise.all(
      ['done', 'in_progress'].map((status) =>
        request(`/tasks/${task.id}/move`, 'POST', {
          status,
          beforeTaskId: null,
          baseVersion: 1,
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      (
        await request(`/tasks/${task.id}`, 'PUT', {
          title: task.title,
          description: '',
          acceptanceCriteria: '',
          status: 'todo',
          priority: 'normal',
          assigneeId: null,
          baseVersion: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      await (await request(`/tasks/${task.id}/history`)).json(),
    ).toHaveLength(2);
  });

  it('rolls back task movement when its history cannot be written', async () => {
    const task = await createTask();
    await database.pool
      .query(`CREATE FUNCTION test_reject_task_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected task history failure'; END; $$;
      CREATE TRIGGER test_task_history_failure BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION test_reject_task_event()`);
    try {
      expect(
        (
          await request(`/tasks/${task.id}/move`, 'POST', {
            status: 'done',
            beforeTaskId: null,
            baseVersion: 1,
          })
        ).status,
      ).toBe(500);
      const list = taskSchema
        .array()
        .parse(await (await request(`/projects/${projectId}/tasks`)).json());
      expect(list.find((item) => item.id === task.id)).toEqual(task);
      expect(
        await (await request(`/tasks/${task.id}/history`)).json(),
      ).toHaveLength(1);
    } finally {
      await database.pool.query(
        'DROP TRIGGER test_task_history_failure ON task_events; DROP FUNCTION test_reject_task_event()',
      );
    }
  });

  it('protects task history and validates members, states and drop targets', async () => {
    const task = await createTask();
    const outsider = userSchema.parse(
      await (
        await request('/auth/session', 'GET', undefined, outsiderCookie)
      ).json(),
    );
    expect(
      (
        await request(`/projects/${projectId}/tasks`, 'POST', {
          title: '非法负责人',
          description: '',
          acceptanceCriteria: '',
          status: 'todo',
          priority: 'normal',
          assigneeId: outsider.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/tasks/${task.id}/move`, 'POST', {
          status: 'unknown',
          beforeTaskId: null,
          baseVersion: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/tasks/${task.id}/move`, 'POST', {
          status: 'done',
          beforeTaskId: task.id,
          baseVersion: 1,
        })
      ).status,
    ).toBe(400);
    const anchor = await createTask({ status: 'todo' });
    expect(
      (
        await request(`/tasks/${task.id}/move`, 'POST', {
          status: 'done',
          beforeTaskId: anchor.id,
          baseVersion: 1,
        })
      ).status,
    ).toBe(400);
    await expect(
      database.pool.query('UPDATE task_events SET kind=$1 WHERE task_id=$2', [
        'move',
        task.id,
      ]),
    ).rejects.toThrow('History is immutable');
    await expect(
      database.pool.query('DELETE FROM task_events WHERE task_id=$1', [
        task.id,
      ]),
    ).rejects.toThrow('History is immutable');
  });

  it('isolates all board endpoints by current workspace membership', async () => {
    const task = await createTask();
    for (const [path, method, body] of [
      [`/projects/${projectId}/tasks`, 'GET', undefined],
      [`/projects/${projectId}/members`, 'GET', undefined],
      [
        `/projects/${projectId}/tasks`,
        'POST',
        {
          title: '越权',
          description: '',
          acceptanceCriteria: '',
          status: 'todo',
          priority: 'normal',
          assigneeId: null,
        },
      ],
      [
        `/tasks/${task.id}/move`,
        'POST',
        { status: 'done', beforeTaskId: null, baseVersion: 1 },
      ],
      [
        `/tasks/${task.id}`,
        'PUT',
        {
          title: '越权',
          description: '',
          acceptanceCriteria: '',
          status: 'todo',
          priority: 'normal',
          assigneeId: null,
          baseVersion: 1,
        },
      ],
      [`/tasks/${task.id}/history`, 'GET', undefined],
    ] as const)
      expect((await request(path, method, body, outsiderCookie)).status).toBe(
        404,
      );
    expect(
      (await request(`/projects/${projectId}/tasks`, 'GET', undefined, ''))
        .status,
    ).toBe(401);
    const outsider = userSchema.parse(
      await (
        await request('/auth/session', 'GET', undefined, outsiderCookie)
      ).json(),
    );
    await database.pool.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [workspaceId, outsider.id],
    );
    expect(
      (
        await request(
          `/tasks/${task.id}/history`,
          'GET',
          undefined,
          outsiderCookie,
        )
      ).status,
    ).toBe(200);
    await database.pool.query(
      'DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
      [workspaceId, outsider.id],
    );
    expect(
      (
        await request(
          `/tasks/${task.id}/history`,
          'GET',
          undefined,
          outsiderCookie,
        )
      ).status,
    ).toBe(404);
  });
  it('turns a conversation into confirmed tasks without writing them early', async () => {
    await database.pool.query(
      `UPDATE change_proposals SET status = 'rejected', resolved_at = now() WHERE project_id = $1 AND status = 'pending'`,
      [projectId],
    );
    const before = await database.pool.query(
      'SELECT count(*) FROM tasks WHERE project_id = $1',
      [projectId],
    );
    proposalModel.stream.mockResolvedValueOnce({
      reply: '范围还不清楚，先不拆任务。',
      tasks: [],
    });
    const clarification = conversationStateSchema.parse(
      await conversationResult(
        await request(`/projects/${projectId}/conversation/messages`, 'POST', {
          body: '做一下登录',
        }),
      ),
    );
    expect(clarification.conversation?.proposal).toBeNull();
    expect(clarification.conversation?.messages.at(-1)?.body).toBe(
      '范围还不清楚，先不拆任务。',
    );
    proposalModel.stream.mockResolvedValueOnce({ reply: '   ', tasks: [] });
    const invalid = await request(
      `/projects/${projectId}/conversation/messages`,
      'POST',
      { body: '再试一次' },
    );
    expect(invalid.status).toBe(502);
    expect(
      (
        await database.pool.query(
          'SELECT count(*) FROM tasks WHERE project_id = $1',
          [projectId],
        )
      ).rows[0].count,
    ).toBe(before.rows[0].count);
    proposalModel.stream.mockResolvedValueOnce({
      reply: '可以拆成两项待办。',
      tasks: [
        {
          title: '设计登录表单',
          description: '邮箱和密码',
          acceptanceCriteria: '可以提交注册',
          priority: 'high',
        },
        {
          title: '保持登录状态',
          description: '七天会话',
          acceptanceCriteria: '刷新后仍登录',
          priority: 'normal',
        },
      ],
    });
    const proposed = conversationStateSchema.parse(
      await conversationResult(
        await request(`/projects/${projectId}/conversation/messages`, 'POST', {
          body: '邮箱密码注册，刷新后仍保持登录',
        }),
      ),
    );
    const proposal = proposed.conversation!.proposal!;
    expect(proposal.status).toBe('pending');
    expect(proposal.items.map((item) => item.taskId)).toEqual([null, null]);
    expect(
      (
        await request(`/projects/${projectId}/conversation/messages`, 'POST', {
          body: '先不要再生成',
        })
      ).status,
    ).toBe(409);
    const blocked = await database.pool.query(
      'SELECT count(*) FROM tasks WHERE project_id = $1',
      [projectId],
    );
    expect(blocked.rows[0].count).toBe(before.rows[0].count);
    const member = await database.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'other@example.com'`,
    );
    await database.pool.query(
      `INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`,
      [workspaceId, member.rows[0]!.id],
    );
    try {
      expect(
        (
          await request(
            `/proposals/${proposal.id}/confirm`,
            'POST',
            undefined,
            outsiderCookie,
          )
        ).status,
      ).toBe(403);
    } finally {
      await database.pool.query(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, member.rows[0]!.id],
      );
    }
    expect(
      (
        await request(
          `/proposals/${proposal.id}/confirm`,
          'POST',
          undefined,
          outsiderCookie,
        )
      ).status,
    ).toBe(404);
    const confirmed = conversationStateSchema.parse(
      await (await request(`/proposals/${proposal.id}/confirm`, 'POST')).json(),
    );
    expect(confirmed.conversation?.proposal?.status).toBe('applied');
    const taskNumbers = confirmed.conversation?.proposal?.items.map(
      (item) => item.taskNumber,
    );
    expect(taskNumbers?.[0]).toEqual(expect.any(Number));
    expect(taskNumbers?.[1]).toBe((taskNumbers?.[0] ?? 0) + 1);
    const again = conversationStateSchema.parse(
      await (await request(`/proposals/${proposal.id}/confirm`, 'POST')).json(),
    );
    expect(again.conversation?.proposal?.items).toEqual(
      confirmed.conversation?.proposal?.items,
    );
    const tasks = taskSchema
      .array()
      .parse(await (await request(`/projects/${projectId}/tasks`)).json());
    expect(tasks.filter((task) => task.title === '设计登录表单')).toHaveLength(
      1,
    );
    const created = tasks.find((task) => task.title === '保持登录状态')!;
    expect(created).toMatchObject({
      status: 'todo',
      priority: 'normal',
      assigneeId: null,
    });
    const history = taskEventSchema
      .array()
      .parse(await (await request(`/tasks/${created.id}/history`)).json());
    expect(history[0]).toMatchObject({
      kind: 'create',
      proposalId: proposal.id,
      actorName: '负责人',
    });
  });

  it('invites a registered member, keeps one admin, and releases that member’s work', async () => {
    async function responseMessage(response: Response) {
      const body = (await response.json()) as { message?: unknown };
      return body.message;
    }
    const outsider = userSchema.parse(
      await (
        await request('/auth/session', 'GET', undefined, outsiderCookie)
      ).json(),
    );
    await database.pool.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, outsider.id],
    );
    const hiddenList = await request(
      `/workspaces/${workspaceId}/members`,
      'GET',
      undefined,
      outsiderCookie,
    );
    expect(hiddenList.status).toBe(404);
    expect(await responseMessage(hiddenList)).toBe(
      '工作空间不存在或无权访问。',
    );
    const hiddenInvite = await request(
      `/workspaces/${workspaceId}/members`,
      'POST',
      { email: 'owner@example.com' },
      outsiderCookie,
    );
    expect(hiddenInvite.status).toBe(404);
    expect(await responseMessage(hiddenInvite)).toBe(
      '工作空间不存在或无权访问。',
    );

    const invited = await request(
      `/workspaces/${workspaceId}/members`,
      'POST',
      {
        email: 'Other@Example.com',
      },
    );
    expect(invited.status).toBe(201);
    expect(workspaceMemberSchema.parse(await invited.json())).toMatchObject({
      id: outsider.id,
      name: '其他用户',
      email: 'other@example.com',
      role: 'member',
    });
    const duplicate = await request(
      `/workspaces/${workspaceId}/members`,
      'POST',
      { email: 'other@example.com' },
    );
    expect(duplicate.status).toBe(409);
    expect(await responseMessage(duplicate)).toBe(
      '这个账号已经是工作空间成员。',
    );
    const unknown = await request(
      `/workspaces/${workspaceId}/members`,
      'POST',
      { email: 'missing@example.com' },
    );
    expect(unknown.status).toBe(404);
    expect(await responseMessage(unknown)).toBe('没有使用这个邮箱的账号。');
    const memberInvite = await request(
      `/workspaces/${workspaceId}/members`,
      'POST',
      { email: 'ghost@example.com' },
      outsiderCookie,
    );
    expect(memberInvite.status).toBe(403);
    expect(await responseMessage(memberInvite)).toBe(
      '只有管理员可以管理成员。',
    );
    const memberRemovesOwner = await request(
      `/workspaces/${workspaceId}/members/${ownerId}`,
      'DELETE',
      undefined,
      outsiderCookie,
    );
    expect(memberRemovesOwner.status).toBe(403);
    expect(await responseMessage(memberRemovesOwner)).toBe(
      '只有管理员可以管理成员。',
    );

    const visible = workspaceMemberSchema
      .array()
      .parse(
        await (
          await request(
            `/workspaces/${workspaceId}/members`,
            'GET',
            undefined,
            outsiderCookie,
          )
        ).json(),
      );
    expect(visible.map((member) => member.role)).toEqual(['admin', 'member']);
    const boardMembers = (await (
      await request(`/projects/${projectId}/members`)
    ).json()) as Array<Record<string, unknown>>;
    expect(boardMembers[0]).not.toHaveProperty('email');
    expect(projectMemberSchema.array().parse(boardMembers)).toHaveLength(2);

    const task = await createTask({ assigneeId: outsider.id });
    const messageId = randomUUID();
    const runId = randomUUID();
    const proposalId = randomUUID();
    await database.pool.query(
      `INSERT INTO conversations(id, workspace_id, project_id, created_by)
       VALUES($1,$2,$3,$4) ON CONFLICT (project_id) DO NOTHING`,
      [randomUUID(), workspaceId, projectId, outsider.id],
    );
    const conversation = await database.pool.query<{ id: string }>(
      'SELECT id FROM conversations WHERE project_id = $1',
      [projectId],
    );
    const conversationId = conversation.rows[0]!.id;
    await database.pool.query(
      `INSERT INTO messages(id, conversation_id, workspace_id, author_type, author_id, body)
       VALUES($1,$2,$3,'user',$4,'请拆分这项工作')`,
      [messageId, conversationId, workspaceId, outsider.id],
    );
    await database.pool.query(
      `INSERT INTO ai_runs(id, workspace_id, conversation_id, trigger_message_id, initiator_id, status, model, finished_at)
       VALUES($1,$2,$3,$4,$5,'succeeded','test-model',now())`,
      [runId, workspaceId, conversationId, messageId, outsider.id],
    );
    await database.pool.query(
      `INSERT INTO change_proposals(id, workspace_id, project_id, conversation_id, ai_run_id, initiator_id, status, summary)
       VALUES($1,$2,$3,$4,$5,$6,'pending','待确认的任务')`,
      [proposalId, workspaceId, projectId, conversationId, runId, outsider.id],
    );

    const soleAdmin = await request(
      `/workspaces/${workspaceId}/members/${ownerId}`,
      'DELETE',
    );
    expect(soleAdmin.status).toBe(409);
    expect(await responseMessage(soleAdmin)).toBe(
      '工作空间至少要保留一名管理员。',
    );
    const removed = await request(
      `/workspaces/${workspaceId}/members/${outsider.id}`,
      'DELETE',
    );
    expect(removed.status).toBe(200);
    expect(membershipChangeSchema.parse(await removed.json())).toEqual({
      unassignedTaskCount: 1,
      rejectedProposalCount: 1,
    });
    expect(
      (
        await request(
          `/workspaces/${workspaceId}/projects`,
          'GET',
          undefined,
          outsiderCookie,
        )
      ).status,
    ).toBe(404);
    const tasks = taskSchema
      .array()
      .parse(await (await request(`/projects/${projectId}/tasks`)).json());
    expect(tasks.find((item) => item.id === task.id)?.assigneeId).toBeNull();
    const history = taskEventSchema
      .array()
      .parse(await (await request(`/tasks/${task.id}/history`)).json());
    expect(history[0]).toMatchObject({
      kind: 'edit',
      actorName: '负责人',
      before: { assigneeId: outsider.id },
      after: { assigneeId: null },
    });
    const proposal = await database.pool.query<{
      status: string;
      resolved_at: Date | null;
    }>('SELECT status, resolved_at FROM change_proposals WHERE id = $1', [
      proposalId,
    ]);
    expect(proposal.rows[0]).toMatchObject({ status: 'rejected' });
    expect(proposal.rows[0]?.resolved_at).toBeTruthy();
    const remaining = workspaceMemberSchema
      .array()
      .parse(
        await (await request(`/workspaces/${workspaceId}/members`)).json(),
      );
    expect(remaining.map((member) => member.id)).toEqual([ownerId]);

    const rejoined = await request(
      `/workspaces/${workspaceId}/members`,
      'POST',
      { email: 'other@example.com' },
    );
    expect(rejoined.status).toBe(201);
    const left = await request(
      `/workspaces/${workspaceId}/members/${outsider.id}`,
      'DELETE',
      undefined,
      outsiderCookie,
    );
    expect(left.status).toBe(200);
    expect(membershipChangeSchema.parse(await left.json())).toEqual({
      unassignedTaskCount: 0,
      rejectedProposalCount: 0,
    });
    expect(
      (
        await request(
          `/workspaces/${workspaceId}/projects`,
          'GET',
          undefined,
          outsiderCookie,
        )
      ).status,
    ).toBe(404);

    const promoted = await request(
      `/workspaces/${workspaceId}/members`,
      'POST',
      { email: 'other@example.com' },
    );
    expect(promoted.status).toBe(201);
    await database.pool.query(
      `UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, outsider.id],
    );
    const removedAdmin = await request(
      `/workspaces/${workspaceId}/members/${outsider.id}`,
      'DELETE',
    );
    expect(removedAdmin.status).toBe(200);
    expect(membershipChangeSchema.parse(await removedAdmin.json())).toEqual({
      unassignedTaskCount: 0,
      rejectedProposalCount: 0,
    });
    const stillSole = await request(
      `/workspaces/${workspaceId}/members/${ownerId}`,
      'DELETE',
    );
    expect(stillSole.status).toBe(409);
  });

  it('keeps one object storage configuration for each workspace', async () => {
    async function responseMessage(response: Response) {
      const body = (await response.json()) as { message?: unknown };
      return body.message;
    }
    const outsider = userSchema.parse(
      await (
        await request('/auth/session', 'GET', undefined, outsiderCookie)
      ).json(),
    );
    await database.pool.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, outsider.id],
    );
    const hidden = await request(
      `/workspaces/${workspaceId}/storage`,
      'GET',
      undefined,
      outsiderCookie,
    );
    expect(hidden.status).toBe(404);
    expect(await responseMessage(hidden)).toBe('工作空间不存在或无权访问。');
    expect(
      workspaceStorageStateSchema.parse(
        await (await request(`/workspaces/${workspaceId}/storage`)).json(),
      ),
    ).toEqual({ storage: null, shortcut: null });
    const missingSecret = await request(
      `/workspaces/${workspaceId}/storage`,
      'PUT',
      {
        endpoint: 'https://account.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'weave-images',
        prefix: 'images',
        accessKeyId: 'access-key',
      },
    );
    expect(missingSecret.status).toBe(400);
    expect(await responseMessage(missingSecret)).toBe('请填写访问密钥。');

    const input = {
      endpoint: 'https://account.r2.cloudflarestorage.com/',
      region: 'auto',
      bucket: 'weave-images',
      prefix: 'images',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    };
    const savedResponse = await request(
      `/workspaces/${workspaceId}/storage`,
      'PUT',
      input,
    );
    expect(savedResponse.status).toBe(200);
    const savedBody = (await savedResponse.json()) as {
      storage?: Record<string, unknown>;
    };
    expect(savedBody.storage).not.toHaveProperty('secretAccessKey');
    expect(workspaceStorageStateSchema.parse(savedBody).storage).toMatchObject({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'weave-images',
      prefix: 'images',
      accessKeyId: 'access-key',
    });
    const stored = await database.pool.query<{ secret_access_key: string }>(
      'SELECT secret_access_key FROM workspace_storage WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(stored.rows[0]?.secret_access_key).toBe('secret-key');

    const replaced = workspaceStorageStateSchema.parse(
      await (
        await request(`/workspaces/${workspaceId}/storage`, 'PUT', {
          endpoint: 'http://127.0.0.1:9000',
          region: 'us-east-1',
          bucket: 'weave-images',
          prefix: '',
          accessKeyId: 'next-key',
        })
      ).json(),
    );
    expect(replaced.storage).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      accessKeyId: 'next-key',
      prefix: '',
    });
    const kept = await database.pool.query<{ secret_access_key: string }>(
      'SELECT secret_access_key FROM workspace_storage WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(kept.rows[0]?.secret_access_key).toBe('secret-key');

    await request(`/workspaces/${workspaceId}/members`, 'POST', {
      email: 'other@example.com',
    });
    try {
      const deniedRead = await request(
        `/workspaces/${workspaceId}/storage`,
        'GET',
        undefined,
        outsiderCookie,
      );
      expect(deniedRead.status).toBe(403);
      expect(await responseMessage(deniedRead)).toBe(
        '只有管理员可以设置存储。',
      );
      const deniedWrite = await request(
        `/workspaces/${workspaceId}/storage`,
        'PUT',
        input,
        outsiderCookie,
      );
      expect(deniedWrite.status).toBe(403);
    } finally {
      await database.pool.query(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, outsider.id],
      );
    }
  });

  it('keeps personal storage and can point a workspace at the acting admin', async () => {
    async function responseMessage(response: Response) {
      const body = (await response.json()) as { message?: unknown };
      return body.message;
    }
    const outsider = userSchema.parse(
      await (
        await request('/auth/session', 'GET', undefined, outsiderCookie)
      ).json(),
    );
    await database.pool.query(
      'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, outsider.id],
    );
    await database.pool.query('DELETE FROM user_storage WHERE user_id = $1', [
      outsider.id,
    ]);
    const hidden = await request(
      `/workspaces/${workspaceId}/storage/shortcut`,
      'PUT',
      undefined,
      outsiderCookie,
    );
    expect(hidden.status).toBe(404);
    expect(await responseMessage(hidden)).toBe('工作空间不存在或无权访问。');

    expect(
      userStorageStateSchema.parse(
        await (await request('/account/storage')).json(),
      ),
    ).toEqual({ storage: null });
    const missingSecret = await request('/account/storage', 'PUT', {
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'owner-images',
      prefix: 'images',
      accessKeyId: 'owner-key',
    });
    expect(missingSecret.status).toBe(400);
    expect(await responseMessage(missingSecret)).toBe('请填写访问密钥。');
    const savedResponse = await request('/account/storage', 'PUT', {
      endpoint: 'https://account.r2.cloudflarestorage.com/',
      region: 'auto',
      bucket: 'owner-images',
      prefix: 'images',
      accessKeyId: 'owner-key',
      secretAccessKey: 'owner-secret',
    });
    expect(savedResponse.status).toBe(200);
    const savedText = JSON.stringify(await savedResponse.json());
    expect(savedText).not.toContain('owner-secret');
    expect(
      userStorageStateSchema.parse(JSON.parse(savedText)).storage,
    ).toMatchObject({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      accessKeyId: 'owner-key',
    });
    await request('/account/storage', 'PUT', {
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'owner-images',
      prefix: 'later',
      accessKeyId: 'owner-key',
    });
    const personal = await database.pool.query<{ secret_access_key: string }>(
      'SELECT secret_access_key FROM user_storage WHERE user_id = $1',
      [ownerId],
    );
    expect(personal.rows[0]?.secret_access_key).toBe('owner-secret');

    const linked = workspaceStorageStateSchema.parse(
      await (
        await request(`/workspaces/${workspaceId}/storage/shortcut`, 'PUT')
      ).json(),
    );
    expect(JSON.stringify(linked)).not.toContain('owner-secret');
    expect(linked).toMatchObject({
      storage: {
        endpoint: 'https://account.r2.cloudflarestorage.com',
        prefix: 'later',
      },
      shortcut: { userId: ownerId, name: '负责人' },
    });
    const shortcutRow = await database.pool.query<{
      source_user_id: string;
      secret_access_key: string | null;
    }>(
      'SELECT source_user_id, secret_access_key FROM workspace_storage WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(shortcutRow.rows[0]).toEqual({
      source_user_id: ownerId,
      secret_access_key: null,
    });
    await request('/account/storage', 'PUT', {
      endpoint: 'http://127.0.0.1:9000',
      region: 'auto',
      bucket: 'owner-images',
      prefix: 'later',
      accessKeyId: 'owner-key',
    });
    expect(
      workspaceStorageStateSchema.parse(
        await (await request(`/workspaces/${workspaceId}/storage`)).json(),
      ).storage,
    ).toMatchObject({ endpoint: 'http://127.0.0.1:9000' });

    await request(`/workspaces/${workspaceId}/members`, 'POST', {
      email: 'other@example.com',
    });
    try {
      const denied = await request(
        `/workspaces/${workspaceId}/storage/shortcut`,
        'PUT',
        undefined,
        outsiderCookie,
      );
      expect(denied.status).toBe(403);
      expect(await responseMessage(denied)).toBe('只有管理员可以设置存储。');
      await database.pool.query(
        `UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, outsider.id],
      );
      const needsPersonal = await request(
        `/workspaces/${workspaceId}/storage/shortcut`,
        'PUT',
        undefined,
        outsiderCookie,
      );
      expect(needsPersonal.status).toBe(400);
      expect(await responseMessage(needsPersonal)).toBe(
        '请先保存你的存储配置。',
      );
      await request(
        '/account/storage',
        'PUT',
        {
          endpoint: 'https://other.r2.cloudflarestorage.com',
          region: 'auto',
          bucket: 'other-images',
          prefix: '',
          accessKeyId: 'other-key',
          secretAccessKey: 'other-secret',
        },
        outsiderCookie,
      );
      const taken = workspaceStorageStateSchema.parse(
        await (
          await request(
            `/workspaces/${workspaceId}/storage/shortcut`,
            'PUT',
            undefined,
            outsiderCookie,
          )
        ).json(),
      );
      expect(JSON.stringify(taken)).not.toContain('other-secret');
      expect(taken.shortcut).toEqual({ userId: outsider.id, name: '其他用户' });
      expect(taken.storage).toMatchObject({ bucket: 'other-images' });
      const removed = await request(
        `/workspaces/${workspaceId}/members/${outsider.id}`,
        'DELETE',
      );
      expect(removed.status).toBe(200);
      expect(
        workspaceStorageStateSchema.parse(
          await (await request(`/workspaces/${workspaceId}/storage`)).json(),
        ),
      ).toEqual({ storage: null, shortcut: null });
      const kept = await database.pool.query(
        'SELECT 1 FROM user_storage WHERE user_id = $1',
        [outsider.id],
      );
      expect(kept.rowCount).toBe(1);
    } finally {
      await database.pool.query(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, outsider.id],
      );
    }
  });

  it('limits repeated login attempts using a shared database counter', async () => {
    await database.pool.query(
      'UPDATE auth_attempts SET attempts = 20 WHERE resets_at > now()',
    );
    expect(
      (
        await request(
          '/auth/login',
          'POST',
          { email: 'owner@example.com', password: 'long-test-password' },
          '',
        )
      ).status,
    ).toBe(429);
  });
});
