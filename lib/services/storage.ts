import type { PoolClient } from 'pg';
import type {
  WorkspaceStorage,
  WorkspaceStorageInput,
  WorkspaceStorageState,
} from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';
import type { S3Target } from '../object-storage';
import {
  decryptSecret,
  encryptIfNeeded,
  encryptSecret,
} from '../storage-secret';

const publicColumns = `endpoint, region, bucket, prefix, access_key_id AS "accessKeyId"`;

async function requireAdmin(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  lock: boolean,
) {
  // Reads do not need to lock every member; writes lock only the caller's row.
  const result = await client.query<{ role: 'admin' | 'member' }>(
    `SELECT role FROM workspace_members
     WHERE workspace_id = $1 AND user_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [workspaceId, userId],
  );
  const caller = result.rows[0];
  if (!caller) throw new ApiError(404, '工作空间不存在或无权访问。');
  if (caller.role !== 'admin')
    throw new ApiError(403, '只有管理员可以设置存储。');
}

async function present(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceStorageState> {
  const stored = await client.query<WorkspaceStorage>(
    `SELECT ${publicColumns} FROM workspace_storage WHERE workspace_id = $1`,
    [workspaceId],
  );
  return { storage: stored.rows[0] ?? null };
}

// Callers have already checked membership; the secret never leaves the server.
export async function target(
  client: PoolClient,
  workspaceId: string,
): Promise<(S3Target & { prefix: string }) | null> {
  const stored = await client.query<
    WorkspaceStorage & { secretAccessKey: string }
  >(
    `SELECT ${publicColumns}, secret_access_key AS "secretAccessKey"
     FROM workspace_storage WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = stored.rows[0];
  return row
    ? { ...row, secretAccessKey: decryptSecret(row.secretAccessKey) }
    : null;
}

export function read(userId: string, workspaceId: string) {
  return transaction(async (client) => {
    await requireAdmin(client, workspaceId, userId, false);
    return present(client, workspaceId);
  });
}

export function save(
  userId: string,
  workspaceId: string,
  input: WorkspaceStorageInput,
) {
  return transaction(async (client) => {
    await requireAdmin(client, workspaceId, userId, true);
    const current = await client.query<{ secretAccessKey: string }>(
      `SELECT secret_access_key AS "secretAccessKey" FROM workspace_storage
       WHERE workspace_id = $1 FOR UPDATE`,
      [workspaceId],
    );
    const currentSecret = current.rows[0]?.secretAccessKey;
    const secretAccessKey = input.secretAccessKey
      ? encryptSecret(input.secretAccessKey)
      : currentSecret
        ? encryptIfNeeded(currentSecret)
        : undefined;
    if (!secretAccessKey) throw new ApiError(400, '请填写访问密钥。');
    await client.query(
      `INSERT INTO workspace_storage(
         workspace_id, endpoint, region, bucket, prefix, access_key_id,
         secret_access_key, updated_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id) DO UPDATE SET
         endpoint = EXCLUDED.endpoint,
         region = EXCLUDED.region,
         bucket = EXCLUDED.bucket,
         prefix = EXCLUDED.prefix,
         access_key_id = EXCLUDED.access_key_id,
         secret_access_key = EXCLUDED.secret_access_key,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        workspaceId,
        input.endpoint,
        input.region,
        input.bucket,
        input.prefix,
        input.accessKeyId,
        secretAccessKey,
        userId,
      ],
    );
    return present(client, workspaceId);
  });
}

// Back to the default Vercel Blob store; images already in S3 stop resolving.
export function clear(userId: string, workspaceId: string) {
  return transaction(async (client) => {
    await requireAdmin(client, workspaceId, userId, true);
    await client.query(
      'DELETE FROM workspace_storage WHERE workspace_id = $1',
      [workspaceId],
    );
    return present(client, workspaceId);
  });
}
