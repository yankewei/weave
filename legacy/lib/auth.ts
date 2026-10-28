import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { credentialsSchema, registerSchema, type User } from '@/lib/contracts';
import { pool, transaction } from './db';
import { ApiError } from './http';

const deriveKey = promisify(scrypt);

export const cookieName = 'weave_session';
export const sessionAge = 7 * 24 * 60 * 60 * 1000;

export function digestToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

// The browser only sends the HttpOnly cookie; the database stores its digest.
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(cookieName)?.value;
  if (!isSessionToken(token)) return null;
  const result = await pool.query<User>(
    `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [digestToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new ApiError(401, '请先登录。');
  return user;
}

export function sessionCookie(value: string) {
  return {
    name: cookieName,
    value,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionAge / 1000,
    path: '/',
  };
}

export function attachSession(response: NextResponse, token: string) {
  response.cookies.set(sessionCookie(token));
  return response;
}

export function clearSession(response: NextResponse) {
  response.cookies.set({ ...sessionCookie(''), maxAge: 0 });
  return response;
}

async function createSession(client: PoolClient, userId: string) {
  const token = randomBytes(32).toString('hex');
  await client.query('DELETE FROM sessions WHERE expires_at <= now()');
  await client.query(
    'INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, $3)',
    [digestToken(token), userId, new Date(Date.now() + sessionAge)],
  );
  return token;
}

// Budget per IP; the digest keeps addresses out of the table. Every registration
// spends it, so one address cannot mass-create accounts.
export async function limitAttempts(ip: string) {
  const attempts = await transaction(async (client) => {
    await client.query('DELETE FROM auth_attempts WHERE resets_at < now()');
    const result = await client.query<{ attempts: number }>(
      `INSERT INTO auth_attempts(key, attempts, resets_at) VALUES($1, 1, now() + interval '15 minutes')
       ON CONFLICT(key) DO UPDATE SET attempts = auth_attempts.attempts + 1 RETURNING attempts`,
      [digestToken(ip)],
    );
    return result.rows[0]!.attempts;
  });
  if (attempts > 20)
    throw new ApiError(429, '登录尝试过多，请 15 分钟后重试。');
}

// Each login reserves a slot up front so parallel guesses cannot slip past the
// limit; a correct password hands the slot back, so only failures add up.
export async function loginWithinLimit(
  ip: string,
  input: z.infer<typeof credentialsSchema>,
) {
  await limitAttempts(ip);
  const result = await login(input);
  await pool.query(
    'UPDATE auth_attempts SET attempts = attempts - 1 WHERE key = $1 AND attempts > 0',
    [digestToken(ip)],
  );
  return result;
}

export async function register(input: z.infer<typeof registerSchema>) {
  const salt = randomBytes(16).toString('hex');
  const key = (await deriveKey(input.password, salt, 64)) as Buffer;
  try {
    return await transaction(async (client) => {
      const user = { id: randomUUID(), name: input.name, email: input.email };
      const workspaceId = randomUUID();
      await client.query(
        'INSERT INTO users(id, email, name, password_hash) VALUES($1,$2,$3,$4)',
        [user.id, user.email, user.name, `${salt}:${key.toString('hex')}`],
      );
      await client.query(
        'INSERT INTO workspaces(id, name, created_by) VALUES($1,$2,$3)',
        [workspaceId, input.workspaceName, user.id],
      );
      await client.query(
        "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,'admin')",
        [workspaceId, user.id],
      );
      return { user, token: await createSession(client, user.id) };
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ApiError(409, '这个邮箱已注册，请直接登录。');
    throw error;
  }
}

export async function login(input: z.infer<typeof credentialsSchema>) {
  const account = await transaction(async (client) => {
    const result = await client.query<User & { password_hash: string }>(
      'SELECT id, name, email, password_hash FROM users WHERE email = $1',
      [input.email],
    );
    return result.rows[0];
  });
  // Derive even for unknown accounts to avoid a fast account-existence oracle.
  const [salt, savedKey] = (
    account?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`
  ).split(':');
  const key = (await deriveKey(input.password, salt!, 64)) as Buffer;
  if (!account || !timingSafeEqual(key, Buffer.from(savedKey!, 'hex'))) {
    throw new ApiError(401, '邮箱或密码不正确。');
  }
  const { id, name, email } = account;
  return {
    user: { id, name, email },
    token: await transaction((client) => createSession(client, id)),
  };
}

export async function revokeSession(token: string | undefined) {
  if (!isSessionToken(token)) return;
  await transaction((client) =>
    client.query('DELETE FROM sessions WHERE token_hash = $1', [
      digestToken(token),
    ]),
  );
}
