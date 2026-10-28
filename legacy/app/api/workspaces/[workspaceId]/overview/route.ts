import { requireUser } from '@/lib/auth';
import { handler, json, uuid } from '@/lib/http';
import { overview } from '@/lib/services/workspaces';

export const dynamic = 'force-dynamic';

export const GET = handler<{ workspaceId: string }>(
  async (_request, { workspaceId }) => {
    const user = await requireUser();
    return json(await overview(user.id, uuid(workspaceId, '工作空间')));
  },
);
