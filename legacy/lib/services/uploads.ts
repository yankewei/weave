import { randomUUID } from 'node:crypto';
import { imageUploadMaxBytes, type Upload } from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';
import { deleteObject, getObject, putObject } from '../object-storage';
import { requireProject } from './documents';
import { target } from './storage';

const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const;

type ImageType = keyof typeof extensions;

// Trust the bytes, not the browser's declared type; SVG is never accepted.
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function cleanName(name: string) {
  const trimmed = name.replace(/[\p{Cc}[\]()]/gu, '').trim();
  return (trimmed || '图片').slice(0, 200);
}

export async function create(
  userId: string,
  projectId: string,
  file: { name: string; bytes: Uint8Array },
): Promise<Upload> {
  if (file.bytes.length === 0) throw new ApiError(400, '图片是空的。');
  if (file.bytes.length > imageUploadMaxBytes)
    throw new ApiError(413, '图片不能超过 4 MB。');
  const contentType = sniffImage(file.bytes);
  if (!contentType)
    throw new ApiError(400, '只支持 PNG、JPEG、GIF 和 WebP 图片。');

  const id = randomUUID();
  const fileName = cleanName(file.name);
  const prepared = await transaction(async (client) => {
    const project = await requireProject(client, userId, projectId);
    return {
      workspaceId: project.workspaceId,
      storage: await target(client, project.workspaceId),
    };
  });
  const name = `weave/${prepared.workspaceId}/${id}.${extensions[contentType]}`;
  const key = prepared.storage?.prefix
    ? `${prepared.storage.prefix}/${name}`
    : name;

  // The upload runs outside a transaction so a slow store never holds a connection.
  await putObject(prepared.storage, key, file.bytes, contentType);
  try {
    await transaction(async (client) => {
      await requireProject(client, userId, projectId);
      await client.query(
        `INSERT INTO uploads(id, workspace_id, project_id, backend, object_key, content_type, size, file_name, uploaded_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          prepared.workspaceId,
          projectId,
          prepared.storage ? 's3' : 'blob',
          key,
          contentType,
          file.bytes.length,
          fileName,
          userId,
        ],
      );
    });
  } catch (error) {
    await deleteObject(prepared.storage, key);
    throw error;
  }
  return { id, url: `/api/uploads/${id}`, fileName };
}

export async function open(userId: string, uploadId: string) {
  const found = await transaction(async (client) => {
    const result = await client.query<{
      workspaceId: string;
      backend: 'blob' | 's3';
      objectKey: string;
      contentType: string;
      size: number;
      fileName: string;
    }>(
      `SELECT u.workspace_id AS "workspaceId", u.backend, u.object_key AS "objectKey",
         u.content_type AS "contentType", u.size, u.file_name AS "fileName"
       FROM uploads u
       JOIN workspace_members m ON m.workspace_id = u.workspace_id
       WHERE u.id = $1 AND m.user_id = $2`,
      [uploadId, userId],
    );
    const upload = result.rows[0];
    if (!upload) throw new ApiError(404, '图片不存在或无权访问。');
    const storage =
      upload.backend === 's3' ? await target(client, upload.workspaceId) : null;
    if (upload.backend === 's3' && !storage)
      throw new ApiError(404, '工作空间已不再使用这张图片所在的存储。');
    return { upload, storage };
  });
  const stream = await getObject(found.storage, found.upload.objectKey);
  if (!stream) throw new ApiError(404, '图片已不在存储中。');
  return { ...found.upload, stream };
}
