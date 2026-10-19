import type { PoolClient } from 'pg';
import type {
  WorkspaceStorage,
  WorkspaceStorageInput,
  WorkspaceStorageState,
} from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';
import { encryptIfNeeded, encryptSecret } from '../storage-secret';

const missingWorkspace = '工作空间不存在或无权访问。';
const adminOnly = '只有管理员可以设置存储。';
const missingSecret = '请填写访问密钥。';
const missingPersonal = '请先保存你的存储配置。';

const publicColumns = `endpoint, region, bucket, prefix, access_key_id AS "accessKeyId"`;

type StoredRow = {
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  prefix: string | null;
  accessKeyId: string | null;
  shortcutUserId: string | null;
  shortcutName: string | null;
};

function visible(row: StoredRow): WorkspaceStorage | null {
  if (
    row.endpoint === null ||
    row.region === null ||
    row.bucket === null ||
    row.prefix === null ||
    row.accessKeyId === null
  ) {
    return null;
  }
  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.accessKeyId,
  };
}

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
  if (!caller) throw new ApiError(404, missingWorkspace);
  if (caller.role !== 'admin') throw new ApiError(403, adminOnly);
}

async function present(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceStorageState> {
  const stored = await client.query<StoredRow>(
    `SELECT
       CASE WHEN s.source_user_id IS NULL THEN s.endpoint ELSE linked.endpoint END AS endpoint,
       CASE WHEN s.source_user_id IS NULL THEN s.region ELSE linked.region END AS region,
       CASE WHEN s.source_user_id IS NULL THEN s.bucket ELSE linked.bucket END AS bucket,
       CASE WHEN s.source_user_id IS NULL THEN s.prefix ELSE linked.prefix END AS prefix,
       CASE WHEN s.source_user_id IS NULL THEN s.access_key_id ELSE linked.access_key_id END AS "accessKeyId",
       s.source_user_id AS "shortcutUserId",
       owner.name AS "shortcutName"
     FROM workspace_storage s
     LEFT JOIN users owner ON owner.id = s.source_user_id
     LEFT JOIN workspace_members admin
       ON admin.workspace_id = s.workspace_id
      AND admin.user_id = s.source_user_id
      AND admin.role = 'admin'
     LEFT JOIN user_storage linked
       ON linked.user_id = s.source_user_id
      AND admin.user_id IS NOT NULL
     WHERE s.workspace_id = $1`,
    [workspaceId],
  );
  const row = stored.rows[0];
  if (!row) return { storage: null, shortcut: null };
  return {
    storage: visible(row),
    shortcut: row.shortcutUserId
      ? { userId: row.shortcutUserId, name: row.shortcutName ?? '' }
      : null,
  };
}

export function readOwn(userId: string) {
  return transaction(async (client) => {
    const storage = await client.query<WorkspaceStorage>(
      `SELECT ${publicColumns} FROM user_storage WHERE user_id = $1`,
      [userId],
    );
    return { storage: storage.rows[0] ?? null };
  });
}

export function saveOwn(userId: string, input: WorkspaceStorageInput) {
  return transaction(async (client) => {
    const current = await client.query<{ secretAccessKey: string }>(
      `SELECT secret_access_key AS "secretAccessKey" FROM user_storage
       WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const currentSecret = current.rows[0]?.secretAccessKey;
    const secretAccessKey = input.secretAccessKey
      ? encryptSecret(input.secretAccessKey)
      : currentSecret
        ? encryptIfNeeded(currentSecret)
        : undefined;
    if (!secretAccessKey) throw new ApiError(400, missingSecret);
    const saved = await client.query<WorkspaceStorage>(
      `INSERT INTO user_storage(
         user_id, endpoint, region, bucket, prefix, access_key_id, secret_access_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET
         endpoint = EXCLUDED.endpoint,
         region = EXCLUDED.region,
         bucket = EXCLUDED.bucket,
         prefix = EXCLUDED.prefix,
         access_key_id = EXCLUDED.access_key_id,
         secret_access_key = EXCLUDED.secret_access_key,
         updated_at = now()
       RETURNING ${publicColumns}`,
      [
        userId,
        input.endpoint,
        input.region,
        input.bucket,
        input.prefix,
        input.accessKeyId,
        secretAccessKey,
      ],
    );
    return { storage: saved.rows[0] ?? null };
  });
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
    const current = await client.query<{ secretAccessKey: string | null }>(
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
    if (!secretAccessKey) throw new ApiError(400, missingSecret);
    await client.query(
      `INSERT INTO workspace_storage(
         workspace_id, endpoint, region, bucket, prefix, access_key_id,
         secret_access_key, updated_by, source_user_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)
       ON CONFLICT (workspace_id) DO UPDATE SET
         endpoint = EXCLUDED.endpoint,
         region = EXCLUDED.region,
         bucket = EXCLUDED.bucket,
         prefix = EXCLUDED.prefix,
         access_key_id = EXCLUDED.access_key_id,
         secret_access_key = EXCLUDED.secret_access_key,
         updated_by = EXCLUDED.updated_by,
         source_user_id = NULL,
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

export function useAdmin(userId: string, workspaceId: string) {
  return transaction(async (client) => {
    await requireAdmin(client, workspaceId, userId, true);
    const own = await client.query(
      'SELECT 1 FROM user_storage WHERE user_id = $1',
      [userId],
    );
    if (!own.rowCount) throw new ApiError(400, missingPersonal);
    await client.query(
      `INSERT INTO workspace_storage(
         workspace_id, endpoint, region, bucket, prefix, access_key_id,
         secret_access_key, updated_by, source_user_id
       ) VALUES($1,NULL,NULL,NULL,'',NULL,NULL,$2,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET
         endpoint = NULL,
         region = NULL,
         bucket = NULL,
         prefix = '',
         access_key_id = NULL,
         secret_access_key = NULL,
         updated_by = EXCLUDED.updated_by,
         source_user_id = EXCLUDED.source_user_id,
         updated_at = now()`,
      [workspaceId, userId],
    );
    return present(client, workspaceId);
  });
}

export function clearShortcut(userId: string, workspaceId: string) {
  return transaction(async (client) => {
    await requireAdmin(client, workspaceId, userId, true);
    await client.query(
      `DELETE FROM workspace_storage
       WHERE workspace_id = $1 AND source_user_id IS NOT NULL`,
      [workspaceId],
    );
    return present(client, workspaceId);
  });
}
