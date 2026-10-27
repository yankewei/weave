import { ZodError, type z } from 'zod';

// Route handlers answer with the same JSON error shape the old API used, so the
// client can keep reading body.message for every failure.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const noStore = { 'Cache-Control': 'no-store' } as const;

export function json<T>(body: T, status = 200) {
  return Response.json(body, { status, headers: noStore });
}

export function empty(status = 204) {
  return new Response(null, { status, headers: noStore });
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError)
    return json(
      { statusCode: error.status, message: error.message },
      error.status,
    );
  if (error instanceof ZodError)
    return json(
      {
        statusCode: 400,
        message: error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('；'),
      },
      400,
    );
  const code = (error as { code?: string }).code;
  if (code === '23505')
    return json({ statusCode: 409, message: '数据冲突。' }, 409);
  if (code === '40P01')
    return json(
      { statusCode: 409, message: '数据正在被其他操作处理，请重试。' },
      409,
    );
  console.error('Unhandled API error:', error);
  return json({ statusCode: 500, message: '服务器出错了，请稍后重试。' }, 500);
}

// Wraps a handler so thrown ApiError/ZodError become JSON responses and every
// response stays out of shared caches.
export function handler<P extends Record<string, string>>(
  run: (request: Request, params: P) => Promise<Response>,
) {
  return async (
    request: Request,
    context: { params: Promise<P> } | undefined,
  ): Promise<Response> => {
    try {
      assertSameOrigin(request);
      const params = (await context?.params) ?? ({} as P);
      const response = await run(request, params);
      if (!response.headers.has('Cache-Control'))
        response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// A non-simple header blocks cross-origin form posts; the Origin check keeps
// write requests on the same host even when a proxy forwards them.
export function assertSameOrigin(request: Request) {
  if (safeMethods.has(request.method)) return;
  if (request.headers.get('x-weave-request') !== '1')
    throw new ApiError(403, '请求来源校验失败，请刷新页面后重试。');
  const origin = request.headers.get('origin');
  if (!origin) return;
  const host = request.headers.get('host');
  const configured = process.env.APP_ORIGIN;
  const expected = configured ? new URL(configured).host : host;
  const actual = new URL(origin).host;
  if (actual !== expected && actual !== host)
    throw new ApiError(403, '请求来源不受信任。');
}

export async function body<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new ApiError(400, '请求内容不是有效的 JSON。');
  }
  return schema.parse(payload);
}

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: string | undefined, label: string) {
  if (!value || !uuidPattern.test(value))
    throw new ApiError(400, `${label} 不是有效的标识。`);
  return value;
}

// Proxies append the address they saw, so only the rightmost entries are
// trustworthy; anything to their left came from the client. Vercel and a single
// reverse proxy need one hop; set TRUSTED_PROXY_HOPS for chains such as CDN + nginx.
export function clientIp(request: Request) {
  const entries = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 1);
  return entries[Math.max(0, entries.length - hops)] ?? 'unknown';
}
