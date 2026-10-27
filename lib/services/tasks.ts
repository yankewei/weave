import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import {
  moveTaskSchema,
  type ProjectMember,
  type Task,
  type TaskInput,
  type TaskStatus,
  updateTaskSchema,
} from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';

const taskColumns = `t.id, t.workspace_id AS "workspaceId", t.project_id AS "projectId", t.number,
 t.title, t.description, t.acceptance_criteria AS "acceptanceCriteria", t.status, t.priority,
 t.assignee_id AS "assigneeId", u.name AS "assigneeName", t.position, t.version, t.updated_at AS "updatedAt"`;

export async function project(
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
  if (!result.rows[0]) throw new ApiError(404, '项目不存在或无权访问。');
  return result.rows[0];
}

export async function read(client: PoolClient, userId: string, id: string) {
  const result = await client.query<Task>(
    `SELECT ${taskColumns} FROM tasks t JOIN workspace_members m ON m.workspace_id = t.workspace_id
     LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = $1 AND m.user_id = $2`,
    [id, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, '任务不存在或无权访问。');
  return result.rows[0];
}

export async function validateAssignee(
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
    throw new ApiError(400, '负责人必须是当前工作空间的成员。');
}

// Caller still belongs to the workspace. Clear assignees before that membership row is deleted.
export async function releaseAssignee(
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
    const before = await read(client, actorId, row.id);
    await client.query(
      'UPDATE tasks SET assignee_id = NULL, version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1',
      [row.id, actorId],
    );
    const after = await read(client, actorId, row.id);
    await record(client, actorId, before, after, 'edit');
  }
  return locked.rows.length;
}

export async function record(
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

// Repeated midpoints keep adding digits; past this scale the column is renumbered.
const maxPositionScale = 30;

// Exact numeric midpoints preserve order without rewriting unrelated tasks or their versions.
// Callers hold the project lock, so renumbering a column cannot race another board write.
export async function positionBefore(
  client: PoolClient,
  projectId: string,
  status: TaskStatus,
  taskId: string,
  beforeTaskId: string | null,
) {
  if (beforeTaskId === taskId)
    throw new ApiError(400, '不能将任务放在自身之前。');
  const ordered = await client.query<{ id: string; position: string }>(
    'SELECT id, position FROM tasks WHERE project_id = $1 AND status = $2 AND id <> $3 ORDER BY position, number',
    [projectId, status, taskId],
  );
  const index =
    beforeTaskId === null
      ? ordered.rows.length
      : ordered.rows.findIndex((row) => row.id === beforeTaskId);
  if (index < 0)
    throw new ApiError(400, '目标任务不在当前项目的目标列中，请刷新看板。');
  const previous = ordered.rows[index - 1]?.position;
  const next = ordered.rows[index]?.position;
  const result = await client.query<{ position: string; scale: number }>(
    `SELECT p AS position, scale(p) AS scale FROM (SELECT CASE
       WHEN $2::numeric IS NULL THEN COALESCE($1::numeric,0) + 1024
       WHEN $1::numeric IS NULL THEN $2::numeric - 1024
       ELSE ($1::numeric + $2::numeric) * 0.5 END AS p) AS midpoint`,
    [previous ?? null, next ?? null],
  );
  const { position, scale } = result.rows[0]!;
  if (scale <= maxPositionScale) return position;
  // Leave a whole step free before the insertion point; position is not part of a task's version.
  await client.query(
    `UPDATE tasks t SET position = ordered.rank * 1024
     FROM (SELECT id, row_number() OVER (ORDER BY position, number)
             + CASE WHEN row_number() OVER (ORDER BY position, number) > $4 THEN 1 ELSE 0 END AS rank
           FROM tasks WHERE project_id = $1 AND status = $2 AND id <> $3) AS ordered
     WHERE t.id = ordered.id`,
    [projectId, status, taskId, index],
  );
  return String((index + 1) * 1024);
}

export async function insert(
  client: PoolClient,
  userId: string,
  projectId: string,
  workspaceId: string,
  input: TaskInput,
  source?: { proposalId: string; proposalItemId: string },
) {
  const counter = await client.query<{ number: number }>(
    'UPDATE workspaces SET task_counter = task_counter + 1 WHERE id = $1 RETURNING task_counter AS number',
    [workspaceId],
  );
  const id = randomUUID();
  const position = await positionBefore(
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
  const task = await read(client, userId, id);
  await record(client, userId, null, task, 'create', source);
  return task;
}

export function create(userId: string, projectId: string, input: TaskInput) {
  return transaction(async (client) => {
    const current = await project(client, userId, projectId, true);
    await validateAssignee(client, current.workspaceId, input.assigneeId);
    return insert(client, userId, projectId, current.workspaceId, input);
  });
}

export function change(
  userId: string,
  id: string,
  input: z.infer<typeof updateTaskSchema> | z.infer<typeof moveTaskSchema>,
) {
  return transaction(async (client) => {
    const initial = await read(client, userId, id);
    // Serialize board writes per project before reading the authoritative task version.
    await project(client, userId, initial.projectId, true);
    const current = await read(client, userId, id);
    if (current.version !== input.baseVersion)
      throw new ApiError(
        409,
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
      if (current.status === input.status && currentNext === input.beforeTaskId)
        return current;
      position = await positionBefore(
        client,
        current.projectId,
        input.status,
        id,
        input.beforeTaskId,
      );
      next = { ...current, status: input.status };
    } else {
      await validateAssignee(client, current.workspaceId, input.assigneeId);
      next = input;
      if (current.status !== input.status)
        position = await positionBefore(
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
    const updated = await read(client, userId, id);
    await record(client, userId, current, updated, moving ? 'move' : 'edit');
    return updated;
  });
}

export function projectMembers(userId: string, projectId: string) {
  return transaction(async (client) => {
    const current = await project(client, userId, projectId, false);
    return (
      await client.query<ProjectMember>(
        'SELECT u.id, u.name FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY u.name, u.id',
        [current.workspaceId],
      )
    ).rows;
  });
}

export function list(userId: string, projectId: string) {
  return transaction(async (client) => {
    await project(client, userId, projectId, false);
    return (
      await client.query<Task>(
        `SELECT ${taskColumns} FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.project_id=$1 ORDER BY t.position, t.number`,
        [projectId],
      )
    ).rows;
  });
}

export function history(userId: string, taskId: string) {
  return transaction(async (client) => {
    const task = await read(client, userId, taskId);
    await project(client, userId, task.projectId, false);
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
