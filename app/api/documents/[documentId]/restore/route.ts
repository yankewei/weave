import { restoreDocumentSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json, uuid } from '@/lib/http';
import { change } from '@/lib/services/documents';

export const dynamic = 'force-dynamic';

export const POST = handler<{ documentId: string }>(
  async (request, { documentId }) => {
    const user = await requireUser();
    const input = await body(request, restoreDocumentSchema);
    return json(await change(user.id, uuid(documentId, '文档'), input));
  },
);
