import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import {
  documentInputSchema,
  restoreDocumentSchema,
  updateDocumentSchema,
  type Document,
  type Project,
  type Revision,
} from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';

const documentColumns = `d.id, d.workspace_id AS "workspaceId", d.project_id AS "projectId",
  d.number, d.title, d.body, d.version, d.updated_at AS "updatedAt"`;

async function requireProject(
  client: PoolClient,
  userId: string,
  projectId: string,
) {
  const result = await client.query<Project>(
    `SELECT p.id, p.workspace_id AS "workspaceId", p.name FROM projects p
     JOIN workspace_members m ON m.workspace_id = p.workspace_id
     WHERE p.id = $1 AND m.user_id = $2 FOR SHARE OF p, m`,
    [projectId, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, '项目不存在或无权访问。');
  return result.rows[0];
}

export async function readDocument(
  client: PoolClient,
  userId: string,
  documentId: string,
  lock: boolean,
) {
  const result = await client.query<Document>(
    `SELECT ${documentColumns} FROM documents d
     JOIN workspace_members m ON m.workspace_id = d.workspace_id
     WHERE d.id = $1 AND m.user_id = $2 ${lock ? 'FOR UPDATE OF d' : ''} FOR SHARE OF m`,
    [documentId, userId],
  );
  if (!result.rows[0]) throw new ApiError(404, '文档不存在或无权访问。');
  return result.rows[0];
}

// The sole formal document write path: state, immutable snapshot and audit share one transaction.
async function writeRevision(
  client: PoolClient,
  userId: string,
  document: Document,
  beforeVersion: number | null,
  restoredFrom: number | null,
) {
  const operationId = randomUUID();
  const kind =
    beforeVersion === null
      ? 'create'
      : restoredFrom === null
        ? 'edit'
        : 'restore';
  await client.query(
    `INSERT INTO document_revisions(workspace_id, project_id, document_id, version, title, body, actor_id, operation_id, kind, restored_from_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      document.workspaceId,
      document.projectId,
      document.id,
      document.version,
      document.title,
      document.body,
      userId,
      operationId,
      kind,
      restoredFrom,
    ],
  );
  await client.query(
    `INSERT INTO audit_events(operation_id, workspace_id, project_id, document_id, before_version, after_version, initiator_id, confirmer_id, method)
     VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
    [
      operationId,
      document.workspaceId,
      document.projectId,
      document.id,
      beforeVersion,
      document.version,
      userId,
      kind === 'restore' ? 'restore' : 'manual',
    ],
  );
}

export function create(
  userId: string,
  projectId: string,
  input: z.infer<typeof documentInputSchema>,
) {
  return transaction(async (client) => {
    const project = await requireProject(client, userId, projectId);
    const counter = await client.query<{ number: number }>(
      'UPDATE workspaces SET document_counter = document_counter + 1 WHERE id = $1 RETURNING document_counter AS number',
      [project.workspaceId],
    );
    const result = await client.query<Document>(
      `INSERT INTO documents AS d(id, workspace_id, project_id, number, title, body, version, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,1,$7) RETURNING ${documentColumns}`,
      [
        randomUUID(),
        project.workspaceId,
        projectId,
        counter.rows[0]!.number,
        input.title,
        input.body,
        userId,
      ],
    );
    const document = result.rows[0]!;
    await writeRevision(client, userId, document, null, null);
    return document;
  });
}

export function change(
  userId: string,
  documentId: string,
  input:
    | z.infer<typeof updateDocumentSchema>
    | z.infer<typeof restoreDocumentSchema>,
) {
  return transaction(async (client) => {
    const current = await readDocument(client, userId, documentId, true);
    if (current.version !== input.baseVersion) {
      throw new ApiError(
        409,
        '文档已被修改。你的草稿已保留，请查看最新版本后再保存。',
      );
    }
    let title: string;
    let body: string;
    let restoredFrom: number | null = null;
    if ('revisionVersion' in input) {
      const revision = await client.query<{ title: string; body: string }>(
        'SELECT title, body FROM document_revisions WHERE document_id = $1 AND version = $2',
        [documentId, input.revisionVersion],
      );
      if (!revision.rows[0]) throw new ApiError(404, '历史版本不存在。');
      ({ title, body } = revision.rows[0]);
      restoredFrom = input.revisionVersion;
    } else {
      ({ title, body } = input);
    }
    if (title === current.title && body === current.body) return current;
    const result = await client.query<Document>(
      `UPDATE documents AS d SET title = $2, body = $3, version = version + 1, updated_by = $4, updated_at = now()
       WHERE id = $1 RETURNING ${documentColumns}`,
      [documentId, title, body, userId],
    );
    const document = result.rows[0]!;
    await writeRevision(
      client,
      userId,
      document,
      current.version,
      restoredFrom,
    );
    return document;
  });
}

export function list(userId: string, projectId: string) {
  return transaction(async (client) => {
    await requireProject(client, userId, projectId);
    return (
      await client.query(
        `SELECT d.id, d.workspace_id AS "workspaceId", d.project_id AS "projectId",
      d.number, d.title, d.version, d.updated_at AS "updatedAt" FROM documents d WHERE d.project_id = $1 ORDER BY d.updated_at DESC, d.id`,
        [projectId],
      )
    ).rows;
  });
}

export function read(userId: string, documentId: string) {
  return transaction((client) =>
    readDocument(client, userId, documentId, false),
  );
}

export function revisions(userId: string, documentId: string) {
  return transaction(async (client) => {
    await readDocument(client, userId, documentId, false);
    return (
      await client.query<Revision>(
        `SELECT r.version, r.title, r.body, u.name AS "actorName", r.created_at AS "createdAt", r.operation_id AS "operationId",
       r.kind, r.restored_from_version AS "restoredFromVersion"
       FROM document_revisions r JOIN users u ON u.id = r.actor_id WHERE r.document_id = $1 ORDER BY r.version DESC`,
        [documentId],
      )
    ).rows;
  });
}
