import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { clearSession, cookieName, revokeSession } from '@/lib/auth';
import { handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  await revokeSession((await cookies()).get(cookieName)?.value);
  return clearSession(new NextResponse(null, { status: 204 }));
});
