import { documentInputSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { create, list } from '@/lib/services/documents';

export const dynamic = 'force-dynamic';

export const GET = handler<{ projectId: string }>(
  async (_request, { projectId }) => {
    const user = await requireUser();
    return json(await list(user.id, uuid(projectId, '项目')));
  },
);

export const POST = handler<{ projectId: string }>(
  async (request, { projectId }) => {
    const user = await requireUser();
    const input = await body(request, documentInputSchema);
    return json(await create(user.id, uuid(projectId, '项目'), input), 201);
  },
);
