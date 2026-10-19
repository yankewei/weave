import { inviteMemberSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { invite, list } from '@/lib/services/members';

export const dynamic = 'force-dynamic';

export const GET = handler<{ workspaceId: string }>(
  async (_request, { workspaceId }) => {
    const user = await requireUser();
    return json(await list(user.id, uuid(workspaceId, '工作空间')));
  },
);

export const POST = handler<{ workspaceId: string }>(
  async (request, { workspaceId }) => {
    const user = await requireUser();
    const input = await body(request, inviteMemberSchema);
    return json(
      await invite(user.id, uuid(workspaceId, '工作空间'), input.email),
      201,
    );
  },
);
