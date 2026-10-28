import { requireUser } from '@/lib/auth';
import { handler, json, uuid } from '@/lib/http';
import { projectMembers } from '@/lib/services/tasks';

export const dynamic = 'force-dynamic';

export const GET = handler<{ projectId: string }>(
  async (_request, { projectId }) => {
    const user = await requireUser();
    return json(await projectMembers(user.id, uuid(projectId, '项目')));
  },
);
