import type { PoolClient } from 'pg';
import { type MembershipChange, type WorkspaceMember } from '@/lib/contracts';
import { transaction } from '../db';
import { ApiError } from '../http';
import { releaseAssignee } from './tasks';

const missingWorkspace = '工作空间不存在或无权访问。';
const adminOnly = '只有管理员可以管理成员。';

type LockedMember = { userId: string; role: 'admin' | 'member' };

async function lockMembers(client: PoolClient, workspaceId: string) {
  return (
    await client.query<LockedMember>(
      `SELECT user_id AS "userId", role FROM workspace_members
       WHERE workspace_id = $1 ORDER BY user_id FOR UPDATE`,
      [workspaceId],
    )
  ).rows;
}

export function list(userId: string, workspaceId: string) {
  return transaction(async (client) => {
    const member = await client.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    if (!member.rowCount) throw new ApiError(404, missingWorkspace);
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

export function invite(
  userId: string,
  workspaceId: string,
  email: string,
): Promise<WorkspaceMember> {
  return transaction(async (client) => {
    const members = await lockMembers(client, workspaceId);
    const caller = members.find((member) => member.userId === userId);
    if (!caller) throw new ApiError(404, missingWorkspace);
    if (caller.role !== 'admin') throw new ApiError(403, adminOnly);
    const account = await client.query<{
      id: string;
      name: string;
      email: string;
    }>('SELECT id, name, email FROM users WHERE email = $1', [email]);
    const user = account.rows[0];
    if (!user) throw new ApiError(404, '没有使用这个邮箱的账号。');
    if (members.some((member) => member.userId === user.id))
      throw new ApiError(409, '这个账号已经是工作空间成员。');
    await client.query(
      `INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,'member')`,
      [workspaceId, user.id],
    );
    return { ...user, role: 'member' as const };
  });
}

export function remove(
  userId: string,
  workspaceId: string,
  targetId: string,
): Promise<MembershipChange> {
  return transaction(async (client) => {
    const members = await lockMembers(client, workspaceId);
    const caller = members.find((member) => member.userId === userId);
    if (!caller) throw new ApiError(404, missingWorkspace);
    const target = members.find((member) => member.userId === targetId);
    if (!target) throw new ApiError(404, missingWorkspace);
    if (target.userId !== userId && caller.role !== 'admin')
      throw new ApiError(403, adminOnly);
    const adminCount = members.filter(
      (member) => member.role === 'admin',
    ).length;
    if (target.role === 'admin' && adminCount < 2)
      throw new ApiError(409, '工作空间至少要保留一名管理员。');
    const unassignedTaskCount = await releaseAssignee(
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
      'DELETE FROM workspace_storage WHERE workspace_id = $1 AND source_user_id = $2',
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
}
