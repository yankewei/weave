import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Message = {
  id: string;
  authorType: 'user' | 'assistant';
  authorName: string | null;
  body: string;
  createdAt: string;
};

export function object(
  value: unknown,
  fields: string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new HttpError(400, '请求字段无效。');
  return value as Record<string, unknown>;
}

export function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new HttpError(400, '标识无效。');
  return value.toLowerCase();
}

export function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, '文本无效。');
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < min || length > max) throw new HttpError(400, '文本长度无效。');
  return normalized;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// A signed cursor binds the underlying Pi scan to its conversation and upper bound.
export function encodeCursor(value: unknown, secret: string): string {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(data)
    .digest('base64url');
  return `${data}.${signature}`;
}

export function decodeCursor(value: string, secret: string): unknown {
  if (value.length > 8192) throw new HttpError(400, '历史游标无效。');
  const [data, signature, extra] = value.split('.');
  const expected = createHmac('sha256', secret)
    .update(data ?? '')
    .digest();
  const supplied = Buffer.from(signature ?? '', 'base64url');
  if (
    extra !== undefined ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new HttpError(400, '历史游标无效。');
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, '历史游标无效。');
  }
}
