import { BlobNotFoundError, del, get, put } from '@vercel/blob';
import { AwsClient } from 'aws4fetch';
import { ApiError } from './http';

// A workspace either keeps its own S3-compatible bucket or falls back to the
// deployment's private Vercel Blob store. Both stay behind /api/uploads.
export type S3Target = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function blobReady() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID)
    throw new ApiError(
      503,
      '尚未配置 Vercel Blob，无法上传图片。请设置 BLOB_READ_WRITE_TOKEN，或由管理员配置工作空间的 S3 存储。',
    );
}

function s3(target: S3Target, key: string) {
  const client = new AwsClient({
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    service: 's3',
    region: target.region,
    retries: 0,
  });
  // Path-style addressing works for AWS, R2, MinIO and most compatible stores.
  return { client, url: `${target.endpoint}/${target.bucket}/${key}` };
}

export async function putObject(
  target: S3Target | null,
  key: string,
  bytes: Uint8Array,
  contentType: string,
) {
  if (!target) {
    blobReady();
    try {
      await put(key, Buffer.from(bytes), {
        access: 'private',
        contentType,
        addRandomSuffix: false,
      });
    } catch {
      throw new ApiError(502, '图片上传到 Vercel Blob 失败，请稍后重试。');
    }
    return;
  }
  const { client, url } = s3(target, key);
  const response = await client
    .fetch(url, {
      method: 'PUT',
      body: Buffer.from(bytes),
      headers: { 'Content-Type': contentType },
    })
    .catch(() => null);
  if (!response?.ok)
    throw new ApiError(
      502,
      `图片上传到工作空间存储失败${response ? `（${response.status}）` : ''}，请检查存储配置。`,
    );
}

export async function getObject(
  target: S3Target | null,
  key: string,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!target) {
    blobReady();
    try {
      const result = await get(key, { access: 'private' });
      return result?.statusCode === 200 ? result.stream : null;
    } catch (error) {
      if (error instanceof BlobNotFoundError) return null;
      throw new ApiError(502, '读取图片失败，请稍后重试。');
    }
  }
  const { client, url } = s3(target, key);
  const response = await client.fetch(url).catch(() => null);
  if (response?.status === 404) return null;
  if (!response?.ok || !response.body)
    throw new ApiError(502, '读取工作空间存储失败，请检查存储配置。');
  return response.body;
}

// Best effort: an orphaned object is cheaper than failing the caller twice.
export async function deleteObject(target: S3Target | null, key: string) {
  try {
    if (!target) await del(key);
    else {
      const { client, url } = s3(target, key);
      await client.fetch(url, { method: 'DELETE' });
    }
  } catch {
    /* Leave the object for manual cleanup. */
  }
}
