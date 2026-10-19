import { workspaceStorageInputSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { read, save } from '@/lib/services/storage';

export const dynamic = 'force-dynamic';

export const GET = handler<{ workspaceId: string }>(
  async (_request, { workspaceId }) => {
    const user = await requireUser();
    return json(await read(user.id, uuid(workspaceId, '工作空间')));
  },
);

export const PUT = handler<{ workspaceId: string }>(
  async (request, { workspaceId }) => {
    const user = await requireUser();
    const input = await body(request, workspaceStorageInputSchema);
    return json(await save(user.id, uuid(workspaceId, '工作空间'), input));
  },
);
