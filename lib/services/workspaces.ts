import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  projectInputSchema,
  type Project,
  type Workspace,
  type WorkspaceOverview,
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

type OverviewProject = WorkspaceOverview['projects'][number];
type OverviewDocument = WorkspaceOverview['documents'][number];
type OverviewActivity = WorkspaceOverview['activity'][number];

// The workbench reads across every project in the workspace, so membership is
// checked once here and every query stays scoped to the workspace id.
export function overview(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceOverview> {
  return transaction(async (client) => {
    const member = await client.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    if (!member.rowCount) throw new ApiError(404, '工作空间不存在或无权访问。');
    // Only the initiator can resolve a proposal, so only theirs count as waiting.
    const projects = await client.query<OverviewProject>(
      `SELECT p.id, p.name, t.todo, t."inProgress", t.done, d.documents, c."pendingProposals"
       FROM projects p
       CROSS JOIN LATERAL (
         SELECT count(*) FILTER (WHERE status = 'todo')::int AS todo,
           count(*) FILTER (WHERE status = 'in_progress')::int AS "inProgress",
           count(*) FILTER (WHERE status = 'done')::int AS done
         FROM tasks WHERE project_id = p.id
       ) t
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS documents FROM documents WHERE project_id = p.id
       ) d
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS "pendingProposals" FROM change_proposals
         WHERE project_id = p.id AND status = 'pending' AND initiator_id = $2
       ) c
       WHERE p.workspace_id = $1 ORDER BY p.created_at, p.id`,
      [workspaceId, userId],
    );
    const documents = await client.query<OverviewDocument>(
      `SELECT d.id, d.project_id AS "projectId", p.name AS "projectName", d.title, d.version,
         d.updated_at AS "updatedAt", u.name AS "updatedByName"
       FROM documents d JOIN projects p ON p.id = d.project_id JOIN users u ON u.id = d.updated_by
       WHERE d.workspace_id = $1 ORDER BY d.updated_at DESC, d.id LIMIT 6`,
      [workspaceId],
    );
    const activity = await client.query<OverviewActivity>(
      `SELECT * FROM (
         SELECT e.operation_id AS id, 'task' AS kind, e.kind AS action, e.project_id AS "projectId",
           p.name AS "projectName", e.task_id AS "targetId", e.after_state->>'title' AS title,
           t.number AS "taskNumber", e.after_state->>'status' AS "taskStatus",
           e.proposal_id IS NOT NULL AS "fromProposal", u.name AS "actorName", e.created_at AS "createdAt"
         FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = e.project_id
         JOIN users u ON u.id = e.initiator_id
         WHERE e.workspace_id = $1
         UNION ALL
         SELECT r.operation_id, 'document', r.kind, r.project_id, p.name, r.document_id, r.title,
           NULL, NULL, false, u.name, r.created_at
         FROM document_revisions r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = r.actor_id
         WHERE r.workspace_id = $1
       ) a ORDER BY "createdAt" DESC, id DESC LIMIT 8`,
      [workspaceId],
    );
    return {
      projects: projects.rows,
      documents: documents.rows,
      activity: activity.rows,
    };
  });
}
