import { projectInputSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { createProject, listProjects } from '@/lib/services/workspaces';

export const dynamic = 'force-dynamic';

export const GET = handler<{ workspaceId: string }>(
  async (_request, { workspaceId }) => {
    const user = await requireUser();
    return json(await listProjects(user.id, uuid(workspaceId, '工作空间')));
  },
);

export const POST = handler<{ workspaceId: string }>(
  async (request, { workspaceId }) => {
    const user = await requireUser();
    const input = await body(request, projectInputSchema);
    return json(
      await createProject(user.id, uuid(workspaceId, '工作空间'), input),
      201,
    );
  },
);
