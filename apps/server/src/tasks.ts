import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  moveTaskSchema,
  taskInputSchema,
  updateTaskSchema,
  type ProjectMember,
  type Task,
  type TaskInput,
  type TaskStatus,
} from '@weave/contracts';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { SessionGuard, type AuthorizedRequest } from './auth.js';
import { Database } from './database.js';
import { SchemaPipe } from './validation.js';

const taskColumns = `t.id, t.workspace_id AS "workspaceId", t.project_id AS "projectId", t.number,
 t.title, t.description, t.acceptance_criteria AS "acceptanceCriteria", t.status, t.priority,
 t.assignee_id AS "assigneeId", u.name AS "assigneeName", t.position, t.version, t.updated_at AS "updatedAt"`;

@Injectable()
export class TasksService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async project(
    client: PoolClient,
    userId: string,
    projectId: string,
    write: boolean,
  ) {
    const result = await client.query<{ workspaceId: string }>(
      `SELECT p.workspace_id AS "workspaceId" FROM projects p JOIN workspace_members m ON m.workspace_id = p.workspace_id
       WHERE p.id = $1 AND m.user_id = $2 ${write ? 'FOR UPDATE OF p' : 'FOR SHARE OF p'} FOR SHARE OF m`,
      [projectId, userId],
    );
    if (!result.rows[0]) throw new NotFoundException('项目不存在或无权访问。');
    return result.rows[0];
  }

  async read(client: PoolClient, userId: string, id: string) {
    const result = await client.query<Task>(
      `SELECT ${taskColumns} FROM tasks t JOIN workspace_members m ON m.workspace_id = t.workspace_id
       LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = $1 AND m.user_id = $2`,
      [id, userId],
    );
    if (!result.rows[0]) throw new NotFoundException('任务不存在或无权访问。');
    return result.rows[0];
  }

  async validateAssignee(
    client: PoolClient,
    workspaceId: string,
    assigneeId: string | null,
  ) {
    if (!assigneeId) return;
    const result = await client.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
      [workspaceId, assigneeId],
    );
    if (!result.rowCount)
      throw new BadRequestException('负责人必须是当前工作空间的成员。');
  }

  // Caller still belongs to the workspace. Clear assignees before that membership row is deleted.
  async releaseAssignee(
    client: PoolClient,
    actorId: string,
    workspaceId: string,
    assigneeId: string,
  ) {
    const locked = await client.query<{ id: string }>(
      'SELECT id FROM tasks WHERE workspace_id = $1 AND assignee_id = $2 ORDER BY id FOR UPDATE',
      [workspaceId, assigneeId],
    );
    for (const row of locked.rows) {
      const before = await this.read(client, actorId, row.id);
      await client.query(
        'UPDATE tasks SET assignee_id = NULL, version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1',
        [row.id, actorId],
      );
      const after = await this.read(client, actorId, row.id);
      await this.record(client, actorId, before, after, 'edit');
    }
    return locked.rows.length;
  }

  async record(
    client: PoolClient,
    userId: string,
    before: Task | null,
    after: Task,
    kind: 'create' | 'edit' | 'move',
    source?: { proposalId: string; proposalItemId: string },
  ) {
    await client.query(
      `INSERT INTO task_events(operation_id, workspace_id, project_id, task_id, version, kind, initiator_id, confirmer_id, before_state, after_state, proposal_id, proposal_item_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        after.workspaceId,
        after.projectId,
        after.id,
        after.version,
        kind,
        userId,
        before,
        after,
        source?.proposalId ?? null,
        source?.proposalItemId ?? null,
      ],
    );
  }

  // Exact numeric midpoints preserve order without rewriting unrelated tasks or their versions.
  async positionBefore(
    client: PoolClient,
    projectId: string,
    status: TaskStatus,
    taskId: string,
    beforeTaskId: string | null,
  ) {
    if (beforeTaskId === taskId)
      throw new BadRequestException('不能将任务放在自身之前。');
    const ordered = await client.query<{ id: string; position: string }>(
      'SELECT id, position FROM tasks WHERE project_id = $1 AND status = $2 AND id <> $3 ORDER BY position, number',
      [projectId, status, taskId],
    );
    const index =
      beforeTaskId === null
        ? ordered.rows.length
        : ordered.rows.findIndex((row) => row.id === beforeTaskId);
    if (index < 0)
      throw new BadRequestException(
        '目标任务不在当前项目的目标列中，请刷新看板。',
      );
    const previous = ordered.rows[index - 1]?.position;
    const next = ordered.rows[index]?.position;
    const result = await client.query<{ position: string }>(
      `SELECT CASE WHEN $2::numeric IS NULL THEN COALESCE($1::numeric,0) + 1024
       WHEN $1::numeric IS NULL THEN $2::numeric - 1024 ELSE ($1::numeric + $2::numeric) * 0.5 END AS position`,
      [previous ?? null, next ?? null],
    );
    return result.rows[0]!.position;
  }

  async insert(
    client: PoolClient,
    userId: string,
    projectId: string,
    workspaceId: string,
    input: TaskInput,
    source?: { proposalId: string; proposalItemId: string },
  ) {
    const counter = await client.query<{ number: number }>(
      'UPDATE projects SET task_counter = task_counter + 1 WHERE id = $1 RETURNING task_counter AS number',
      [projectId],
    );
    const id = randomUUID();
    const position = await this.positionBefore(
      client,
      projectId,
      input.status,
      id,
      null,
    );
    await client.query(
      `INSERT INTO tasks(id, workspace_id, project_id, number, title, description, acceptance_criteria, status, priority, assignee_id, position, version, updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)`,
      [
        id,
        workspaceId,
        projectId,
        counter.rows[0]!.number,
        input.title,
        input.description,
        input.acceptanceCriteria,
        input.status,
        input.priority,
        input.assigneeId,
        position,
        userId,
      ],
    );
    const task = await this.read(client, userId, id);
    await this.record(client, userId, null, task, 'create', source);
    return task;
  }

  async create(userId: string, projectId: string, input: TaskInput) {
    return this.database.transaction(async (client) => {
      const project = await this.project(client, userId, projectId, true);
      await this.validateAssignee(
        client,
        project.workspaceId,
        input.assigneeId,
      );
      return this.insert(client, userId, projectId, project.workspaceId, input);
    });
  }

  async change(
    userId: string,
    id: string,
    input: z.infer<typeof updateTaskSchema> | z.infer<typeof moveTaskSchema>,
  ) {
    return this.database.transaction(async (client) => {
      const initial = await this.read(client, userId, id);
      // Serialize board writes per project before reading the authoritative task version.
      await this.project(client, userId, initial.projectId, true);
      const current = await this.read(client, userId, id);
      if (current.version !== input.baseVersion)
        throw new ConflictException(
          '任务已被其他操作修改。请刷新看板后重试，编辑草稿已保留。',
        );
      let position = current.position;
      let next: TaskInput;
      const moving = 'beforeTaskId' in input;
      if (moving) {
        const ordered = await client.query<{ id: string }>(
          'SELECT id FROM tasks WHERE project_id = $1 AND status = $2 ORDER BY position, number',
          [current.projectId, current.status],
        );
        const currentIndex = ordered.rows.findIndex((row) => row.id === id);
        const currentNext = ordered.rows[currentIndex + 1]?.id ?? null;
        if (
          current.status === input.status &&
          currentNext === input.beforeTaskId
        )
          return current;
        position = await this.positionBefore(
          client,
          current.projectId,
          input.status,
          id,
          input.beforeTaskId,
        );
        next = { ...current, status: input.status };
      } else {
        await this.validateAssignee(
          client,
          current.workspaceId,
          input.assigneeId,
        );
        next = input;
        if (current.status !== input.status)
          position = await this.positionBefore(
            client,
            current.projectId,
            input.status,
            id,
            null,
          );
        if (
          [
            'title',
            'description',
            'acceptanceCriteria',
            'status',
            'priority',
            'assigneeId',
          ].every(
            (field) =>
              current[field as keyof TaskInput] ===
              next[field as keyof TaskInput],
          )
        )
          return current;
      }
      await client.query(
        `UPDATE tasks SET title=$2, description=$3, acceptance_criteria=$4, status=$5, priority=$6,
        assignee_id=$7, position=$8, version=version+1, updated_by=$9, updated_at=now() WHERE id=$1`,
        [
          id,
          next.title,
          next.description,
          next.acceptanceCriteria,
          next.status,
          next.priority,
          next.assigneeId,
          position,
          userId,
        ],
      );
      const updated = await this.read(client, userId, id);
      await this.record(
        client,
        userId,
        current,
        updated,
        moving ? 'move' : 'edit',
      );
      return updated;
    });
  }
}

@Controller()
@UseGuards(SessionGuard)
export class TasksController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  @Get('projects/:projectId/members')
  members(
    @Req() request: AuthorizedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.database.transaction(async (client) => {
      const project = await this.tasks.project(
        client,
        request.user.id,
        projectId,
        false,
      );
      return (
        await client.query<ProjectMember>(
          'SELECT u.id, u.name FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name, u.id',
          [project.workspaceId],
        )
      ).rows;
    });
  }

  @Get('projects/:projectId/tasks')
  list(
    @Req() request: AuthorizedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.database.transaction(async (client) => {
      await this.tasks.project(client, request.user.id, projectId, false);
      return (
        await client.query<Task>(
          `SELECT ${taskColumns} FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.project_id=$1 ORDER BY t.position, t.number`,
          [projectId],
        )
      ).rows;
    });
  }

  @Post('projects/:projectId/tasks')
  create(
    @Req() request: AuthorizedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body(new SchemaPipe(taskInputSchema)) input: TaskInput,
  ) {
    return this.tasks.create(request.user.id, projectId, input);
  }

  @Put('tasks/:taskId')
  update(
    @Req() request: AuthorizedRequest,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new SchemaPipe(updateTaskSchema))
    input: z.infer<typeof updateTaskSchema>,
  ) {
    return this.tasks.change(request.user.id, taskId, input);
  }

  @Post('tasks/:taskId/move')
  move(
    @Req() request: AuthorizedRequest,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
    @Body(new SchemaPipe(moveTaskSchema)) input: z.infer<typeof moveTaskSchema>,
  ) {
    return this.tasks.change(request.user.id, taskId, input);
  }

  @Get('tasks/:taskId/history')
  history(
    @Req() request: AuthorizedRequest,
    @Param('taskId', new ParseUUIDPipe()) taskId: string,
  ) {
    return this.database.transaction(async (client) => {
      const task = await this.tasks.read(client, request.user.id, taskId);
      await this.tasks.project(client, request.user.id, task.projectId, false);
      return (
        await client.query(
          `SELECT e.operation_id AS "operationId", e.version, e.kind, u.name AS "actorName", e.created_at AS "createdAt",
        e.before_state AS before, e.after_state AS after, e.proposal_id AS "proposalId"
        FROM task_events e JOIN users u ON u.id=e.initiator_id WHERE e.task_id=$1 ORDER BY e.version DESC`,
          [taskId],
        )
      ).rows;
    });
  }
}
