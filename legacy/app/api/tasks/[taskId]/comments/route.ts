import { taskCommentInputSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { create, list } from '@/lib/services/comments';

export const dynamic = 'force-dynamic';

export const GET = handler<{ taskId: string }>(async (_request, { taskId }) => {
  const user = await requireUser();
  return json(await list(user.id, uuid(taskId, '任务')));
});

export const POST = handler<{ taskId: string }>(async (request, { taskId }) => {
  const user = await requireUser();
  const input = await body(request, taskCommentInputSchema);
  return json(await create(user.id, uuid(taskId, '任务'), input), 201);
});
