import { requireUser } from '@/lib/auth';
import { empty, handler, uuid } from '@/lib/http';
import { remove } from '@/lib/services/comments';

export const dynamic = 'force-dynamic';

export const DELETE = handler<{ taskId: string; commentId: string }>(
  async (_request, { taskId, commentId }) => {
    const user = await requireUser();
    await remove(user.id, uuid(taskId, '任务'), uuid(commentId, '评论'));
    return empty(204);
  },
);
