import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';
import { credentialsSchema, registerSchema, type User } from '@weave/contracts';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { Database } from './database.js';
import { SchemaPipe } from './validation.js';

const deriveKey = promisify(scrypt);
const cookieName = 'weave_session';
const sessionAge = 7 * 24 * 60 * 60 * 1000;
export type AuthorizedRequest = Request & { user: User };

// Tokens stay in HttpOnly cookies. Only their digest is persisted.
export function sessionDigest(request: Request) {
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class RequestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    // A non-simple header prevents cross-origin form posts; no CORS is enabled.
    if (request.headers['x-weave-request'] !== '1') {
      throw new ForbiddenException('请求来源校验失败，请刷新页面后重试。');
    }
    if (
      request.headers.origin &&
      request.headers.origin !==
        (process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173')
    ) {
      throw new ForbiddenException('请求来源不受信任。');
    }
    return true;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Database) private readonly database: Database) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    const digest = sessionDigest(request);
    if (!digest) throw new UnauthorizedException('请先登录。');
    const user = await this.database.transaction(async (client) => {
      const result = await client.query<User>(
        `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [digest],
      );
      return result.rows[0];
    });
    if (!user) throw new UnauthorizedException('登录已过期，请重新登录。');
    request.user = user;
    return true;
  }
}

@Injectable()
export class AuthService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async limitAttempts(ip: string) {
    const key = createHash('sha256').update(ip).digest('hex');
    const attempts = await this.database.transaction(async (client) => {
      await client.query('DELETE FROM auth_attempts WHERE resets_at < now()');
      const result = await client.query<{ attempts: number }>(
        `INSERT INTO auth_attempts(key, attempts, resets_at) VALUES($1, 1, now() + interval '15 minutes')
         ON CONFLICT(key) DO UPDATE SET attempts = auth_attempts.attempts + 1 RETURNING attempts`,
        [key],
      );
      return result.rows[0]!.attempts;
    });
    if (attempts > 20)
      throw new HttpException('登录尝试过多，请 15 分钟后重试。', 429);
  }

  async createSession(client: PoolClient, userId: string) {
    const token = randomBytes(32).toString('hex');
    await client.query('DELETE FROM sessions WHERE expires_at <= now()');
    await client.query(
      'INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, $3)',
      [
        createHash('sha256').update(token).digest('hex'),
        userId,
        new Date(Date.now() + sessionAge),
      ],
    );
    return token;
  }

  async register(input: z.infer<typeof registerSchema>) {
    const salt = randomBytes(16).toString('hex');
    const key = (await deriveKey(input.password, salt, 64)) as Buffer;
    try {
      return await this.database.transaction(async (client) => {
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
        return { user, token: await this.createSession(client, user.id) };
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('这个邮箱已注册，请直接登录。');
      throw error;
    }
  }

  async login(input: z.infer<typeof credentialsSchema>) {
    const account = await this.database.transaction(async (client) => {
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
      throw new UnauthorizedException('邮箱或密码不正确。');
    }
    const { id, name, email } = account;
    return {
      user: { id, name, email },
      token: await this.database.transaction((client) =>
        this.createSession(client, id),
      ),
    };
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Database) private readonly database: Database,
  ) {}

  @Post('register')
  async register(
    @Body(new SchemaPipe(registerSchema)) input: z.infer<typeof registerSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.limitAttempts(request.ip ?? 'unknown');
    const result = await this.auth.register(input);
    response.cookie(cookieName, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: sessionAge,
      path: '/api',
    });
    return result.user;
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new SchemaPipe(credentialsSchema))
    input: z.infer<typeof credentialsSchema>,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.limitAttempts(request.ip ?? 'unknown');
    const result = await this.auth.login(input);
    const previous = sessionDigest(request);
    if (previous)
      await this.database.transaction((client) =>
        client.query('DELETE FROM sessions WHERE token_hash = $1', [previous]),
      );
    response.cookie(cookieName, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: sessionAge,
      path: '/api',
    });
    return result.user;
  }

  @Get('session')
  @UseGuards(SessionGuard)
  session(@Req() request: AuthorizedRequest) {
    return request.user;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const digest = sessionDigest(request);
    if (digest)
      await this.database.transaction((client) =>
        client.query('DELETE FROM sessions WHERE token_hash = $1', [digest]),
      );
    response.clearCookie(cookieName, {
      path: '/api',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
  }
}
