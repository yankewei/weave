import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  inviteMemberSchema,
  type MembershipChange,
  type WorkspaceMember,
} from '@weave/contracts';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { SessionGuard, type AuthorizedRequest } from './auth.js';
import { Database } from './database.js';
import { TasksService } from './tasks.js';
import { SchemaPipe } from './validation.js';

const missingWorkspace = '工作空间不存在或无权访问。';
const adminOnly = '只有管理员可以管理成员。';

type LockedMember = { userId: string; role: 'admin' | 'member' };

@Injectable()
export class MembersService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  private async lockMembers(client: PoolClient, workspaceId: string) {
    return (
      await client.query<LockedMember>(
        `SELECT user_id AS "userId", role FROM workspace_members
         WHERE workspace_id = $1 ORDER BY user_id FOR UPDATE`,
        [workspaceId],
      )
    ).rows;
  }

  async list(userId: string, workspaceId: string) {
    return this.database.transaction(async (client) => {
      const member = await client.query(
        'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId],
      );
      if (!member.rowCount) throw new NotFoundException(missingWorkspace);
      return (
        await client.query<WorkspaceMember>(
          `SELECT u.id, u.name, u.email, m.role
           FROM workspace_members m JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id = $1 ORDER BY m.role, u.name, u.id`,
          [workspaceId],
        )
      ).rows;
    });
  }

  async invite(
    userId: string,
    workspaceId: string,
    email: string,
  ): Promise<WorkspaceMember> {
    try {
      return await this.database.transaction(async (client) => {
        const members = await this.lockMembers(client, workspaceId);
        const caller = members.find((member) => member.userId === userId);
        if (!caller) throw new NotFoundException(missingWorkspace);
        if (caller.role !== 'admin') throw new ForbiddenException(adminOnly);
        const account = await client.query<{
          id: string;
          name: string;
          email: string;
        }>('SELECT id, name, email FROM users WHERE email = $1', [email]);
        const user = account.rows[0];
        if (!user) throw new NotFoundException('没有使用这个邮箱的账号。');
        if (members.some((member) => member.userId === user.id))
          throw new ConflictException('这个账号已经是工作空间成员。');
        await client.query(
          `INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,'member')`,
          [workspaceId, user.id],
        );
        return { ...user, role: 'member' as const };
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('这个账号已经是工作空间成员。');
      throw error;
    }
  }

  async remove(
    userId: string,
    workspaceId: string,
    targetId: string,
  ): Promise<MembershipChange> {
    try {
      return await this.database.transaction(async (client) => {
        const members = await this.lockMembers(client, workspaceId);
        const caller = members.find((member) => member.userId === userId);
        if (!caller) throw new NotFoundException(missingWorkspace);
        const target = members.find((member) => member.userId === targetId);
        if (!target) throw new NotFoundException(missingWorkspace);
        if (target.userId !== userId && caller.role !== 'admin')
          throw new ForbiddenException(adminOnly);
        const adminCount = members.filter(
          (member) => member.role === 'admin',
        ).length;
        if (target.role === 'admin' && adminCount < 2)
          throw new ConflictException('工作空间至少要保留一名管理员。');
        const unassignedTaskCount = await this.tasks.releaseAssignee(
          client,
          userId,
          workspaceId,
          target.userId,
        );
        // Only the initiator can confirm a proposal. Reject it before they lose access.
        const rejected = await client.query(
          `UPDATE change_proposals SET status = 'rejected', resolved_at = now()
           WHERE workspace_id = $1 AND initiator_id = $2 AND status = 'pending'`,
          [workspaceId, target.userId],
        );
        // The shortcut follows this admin's personal storage and ends with their membership.
        await client.query(
          `DELETE FROM workspace_storage
           WHERE workspace_id = $1 AND source_user_id = $2`,
          [workspaceId, target.userId],
        );
        await client.query(
          'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
          [workspaceId, target.userId],
        );
        return {
          unassignedTaskCount,
          rejectedProposalCount: rejected.rowCount ?? 0,
        };
      });
    } catch (error) {
      if ((error as { code?: string }).code === '40P01')
        throw new ConflictException('成员正在被其他操作处理，请重试。');
      throw error;
    }
  }
}

@Controller()
@UseGuards(SessionGuard)
export class MembersController {
  constructor(
    @Inject(MembersService) private readonly members: MembersService,
  ) {}

  @Get('workspaces/:workspaceId/members')
  list(
    @Req() request: AuthorizedRequest,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
  ) {
    return this.members.list(request.user.id, workspaceId);
  }

  @Post('workspaces/:workspaceId/members')
  invite(
    @Req() request: AuthorizedRequest,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body(new SchemaPipe(inviteMemberSchema))
    input: z.infer<typeof inviteMemberSchema>,
  ) {
    return this.members.invite(request.user.id, workspaceId, input.email);
  }

  @Delete('workspaces/:workspaceId/members/:userId')
  remove(
    @Req() request: AuthorizedRequest,
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.members.remove(request.user.id, workspaceId, userId);
  }
}
