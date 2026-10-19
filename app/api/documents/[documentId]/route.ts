import { updateDocumentSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { change, read } from '@/lib/services/documents';

export const dynamic = 'force-dynamic';

export const GET = handler<{ documentId: string }>(
  async (_request, { documentId }) => {
    const user = await requireUser();
    return json(await read(user.id, uuid(documentId, '文档')));
  },
);

export const PUT = handler<{ documentId: string }>(
  async (request, { documentId }) => {
    const user = await requireUser();
    const input = await body(request, updateDocumentSchema);
    return json(await change(user.id, uuid(documentId, '文档'), input));
  },
);
