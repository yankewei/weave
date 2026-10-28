import { NextResponse } from 'next/server';
import { registerSchema } from '@/lib/contracts';
import { attachSession, limitAttempts, register } from '@/lib/auth';
import { body, clientIp, handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request) => {
  await limitAttempts(clientIp(request));
  const result = await register(await body(request, registerSchema));
  return attachSession(NextResponse.json(result.user), result.token);
});
