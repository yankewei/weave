import { requireUser } from '@/lib/auth';
import { empty, handler, uuid } from '@/lib/http';
import { remove } from '@/lib/services/members';

export const dynamic = 'force-dynamic';

export const DELETE = handler<{ workspaceId: string; userId: string }>(
  async (_request, { workspaceId, userId }) => {
    const user = await requireUser();
    await remove(user.id, uuid(workspaceId, '工作空间'), uuid(userId, '成员'));
    return empty(204);
  },
);
