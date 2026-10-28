import { json, handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () =>
  json({ status: 'ok', service: 'weave-api' }),
);
