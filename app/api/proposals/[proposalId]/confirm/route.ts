import { requireUser } from '@/lib/auth';
import { handler, json, uuid } from '@/lib/http';
import { resolve } from '@/lib/services/conversations';

export const dynamic = 'force-dynamic';

export const POST = handler<{ proposalId: string }>(
  async (_request, { proposalId }) => {
    const user = await requireUser();
    return json(await resolve(user.id, uuid(proposalId, '提案'), 'applied'));
  },
);
