import type { PoolClient } from 'pg';
import type { TaskStatus } from '@/lib/contracts';
import { taskStatusLabels } from '@/lib/task-ui';
import { type Reference, parseReference } from '@/lib/references';
import { transaction } from '../db';
import { uuidPattern } from '../http';

/** Where a DEV-n or DOC-n key points for a member, or null when it points nowhere. */
export function locate(userId: string, workspaceId: string, key: string) {
  const reference = parseReference(key);
  if (!reference || !uuidPattern.test(workspaceId))
    return Promise.resolve(null);
  return transaction(async (client) => {
    const result = await client.query<{ id: string; projectId: string }>(
      `SELECT x.id, x.project_id AS "projectId" FROM ${
        reference.kind === 'task' ? 'tasks' : 'documents'
      } x JOIN workspace_members m ON m.workspace_id = x.workspace_id AND m.user_id = $3
       WHERE x.workspace_id = $1 AND x.number = $2`,
      [workspaceId, reference.number, userId],
    );
    const target = result.rows[0];
    if (!target) return null;
    const project = `/workspaces/${workspaceId}/projects/${target.projectId}`;
    return reference.kind === 'task'
      ? `${project}/board?task=${target.id}`
      : `${project}/documents/${target.id}`;
  });
}

// Keeps a handful of referenced documents from crowding out the conversation.
const maxReferences = 6;
const maxDocumentChars = 12_000;

/** Wraps referenced tasks and documents in <reference> tags for the model; unknown keys are listed as missing. */
export async function referenceContext(
  client: PoolClient,
  workspaceId: string,
  references: Reference[],
) {
  const picked = references.slice(0, maxReferences);
  if (!picked.length) return '';
  const numbers = (kind: Reference['kind']) =>
    picked.filter((item) => item.kind === kind).map((item) => item.number);
  const tasks = await client.query<{
    number: number;
    title: string;
    description: string;
    acceptanceCriteria: string;
    status: TaskStatus;
    projectName: string;
  }>(
    `SELECT t.number, t.title, t.description, t.acceptance_criteria AS "acceptanceCriteria",
     t.status, p.name AS "projectName"
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.workspace_id = $1 AND t.number = ANY($2::int[])`,
    [workspaceId, numbers('task')],
  );
  const documents = await client.query<{
    number: number;
    title: string;
    body: string;
    projectName: string;
  }>(
    `SELECT d.number, d.title, d.body, p.name AS "projectName"
     FROM documents d JOIN projects p ON p.id = d.project_id
     WHERE d.workspace_id = $1 AND d.number = ANY($2::int[])`,
    [workspaceId, numbers('document')],
  );
  const entries = picked.map((reference) => {
    if (reference.kind === 'task') {
      const task = tasks.rows.find((row) => row.number === reference.number);
      return task
        ? [
            `任务：${task.title}`,
            `项目：${task.projectName}；状态：${taskStatusLabels[task.status]}`,
            `描述：\n${task.description || '（空）'}`,
            `验收标准：\n${task.acceptanceCriteria || '（空）'}`,
          ].join('\n')
        : null;
    }
    const document = documents.rows.find(
      (row) => row.number === reference.number,
    );
    if (!document) return null;
    const body =
      document.body.length > maxDocumentChars
        ? `${document.body.slice(0, maxDocumentChars)}\n（正文过长，已截断）`
        : document.body;
    return `文档：${document.title}\n项目：${document.projectName}\n正文：\n${body || '（空）'}`;
  });
  return `以下是我引用的资料，只作参考：\n\n${picked
    .map(
      (reference, index) =>
        `<reference key="${reference.key}">\n${
          // Stored text must not be able to close the tag and speak as the user.
          (entries[index] ?? '不存在或已无法访问。').replaceAll(
            '</reference',
            '<\\/reference',
          )
        }\n</reference>`,
    )
    .join('\n\n')}`;
}
