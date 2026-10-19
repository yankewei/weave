import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { credentialsSchema } from '@/lib/contracts';
import {
  attachSession,
  cookieName,
  limitAttempts,
  login,
  revokeSession,
} from '@/lib/auth';
import { body, clientIp, handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request) => {
  await limitAttempts(clientIp(request));
  const result = await login(await body(request, credentialsSchema));
  await revokeSession((await cookies()).get(cookieName)?.value);
  return attachSession(NextResponse.json(result.user), result.token);
});
