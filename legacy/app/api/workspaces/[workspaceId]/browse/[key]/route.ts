import { requireUser } from '@/lib/auth';
import { ApiError, handler, json } from '@/lib/http';
import { locate } from '@/lib/services/references';

export const dynamic = 'force-dynamic';

export const GET = handler<{ workspaceId: string; key: string }>(
  async (_request, { workspaceId, key }) => {
    const user = await requireUser();
    const path = await locate(user.id, workspaceId, decodeURIComponent(key));
    if (!path)
      throw new ApiError(404, '这个编号在当前工作空间里没有对应的任务或文档。');
    return json({ path });
  },
);
