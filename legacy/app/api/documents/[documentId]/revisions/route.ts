import { requireUser } from '@/lib/auth';
import { handler, json, uuid } from '@/lib/http';
import { revisions } from '@/lib/services/documents';

export const dynamic = 'force-dynamic';

export const GET = handler<{ documentId: string }>(
  async (_request, { documentId }) => {
    const user = await requireUser();
    return json(await revisions(user.id, uuid(documentId, '文档')));
  },
);
