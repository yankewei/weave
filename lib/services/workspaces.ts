import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  projectInputSchema,
  type Project,
  type Workspace,
} from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';

export function listWorkspaces(userId: string) {
  return transaction(
    async (client) =>
      (
        await client.query<Workspace>(
          `SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = $1 ORDER BY w.name, w.id`,
          [userId],
        )
      ).rows,
  );
}

export function listProjects(userId: string, workspaceId: string) {
  return transaction(async (client) => {
    const member = await client.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    if (!member.rowCount) throw new ApiError(404, '工作空间不存在或无权访问。');
    return (
      await client.query<Project>(
        'SELECT id, workspace_id AS "workspaceId", name FROM projects WHERE workspace_id = $1 ORDER BY created_at, id',
        [workspaceId],
      )
    ).rows;
  });
}

export function createProject(
  userId: string,
  workspaceId: string,
  input: z.infer<typeof projectInputSchema>,
) {
  return transaction(async (client) => {
    const member = await client.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR SHARE',
      [workspaceId, userId],
    );
    if (!member.rowCount) throw new ApiError(404, '工作空间不存在或无权访问。');
    return (
      await client.query<Project>(
        'INSERT INTO projects(id, workspace_id, name) VALUES($1,$2,$3) RETURNING id, workspace_id AS "workspaceId", name',
        [randomUUID(), workspaceId, input.name],
      )
    ).rows[0]!;
  });
}
