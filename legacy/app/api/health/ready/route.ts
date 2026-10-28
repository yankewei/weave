import { ping } from '@/lib/db';
import { ApiError, json, handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  try {
    await ping();
  } catch {
    throw new ApiError(503, '数据库不可用。');
  }
  return json({ status: 'ok', service: 'weave-api', database: 'ok' });
});
