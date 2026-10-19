import { requireUser } from '@/lib/auth';
import { handler, json, uuid } from '@/lib/http';
import { clearShortcut, useAdmin } from '@/lib/services/storage';

export const dynamic = 'force-dynamic';

export const PUT = handler<{ workspaceId: string }>(
  async (_request, { workspaceId }) => {
    const user = await requireUser();
    return json(await useAdmin(user.id, uuid(workspaceId, '工作空间')));
  },
);

export const DELETE = handler<{ workspaceId: string }>(
  async (_request, { workspaceId }) => {
    const user = await requireUser();
    return json(await clearShortcut(user.id, uuid(workspaceId, '工作空间')));
  },
);
