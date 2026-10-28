import { requireUser } from '@/lib/auth';
import { handler, json, uuid } from '@/lib/http';
import { history } from '@/lib/services/tasks';

export const dynamic = 'force-dynamic';

export const GET = handler<{ taskId: string }>(async (_request, { taskId }) => {
  const user = await requireUser();
  return json(await history(user.id, uuid(taskId, '任务')));
});
