import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { credentialsSchema } from '@/lib/contracts';
import {
  attachSession,
  cookieName,
  loginWithinLimit,
  revokeSession,
} from '@/lib/auth';
import { body, clientIp, handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request) => {
  const result = await loginWithinLimit(
    clientIp(request),
    await body(request, credentialsSchema),
  );
  await revokeSession((await cookies()).get(cookieName)?.value);
  return attachSession(NextResponse.json(result.user), result.token);
});
