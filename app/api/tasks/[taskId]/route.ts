import { updateTaskSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { change } from '@/lib/services/tasks';

export const dynamic = 'force-dynamic';

export const PUT = handler<{ taskId: string }>(async (request, { taskId }) => {
  const user = await requireUser();
  const input = await body(request, updateTaskSchema);
  return json(await change(user.id, uuid(taskId, '任务'), input));
});
