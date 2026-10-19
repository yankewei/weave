import { workspaceStorageInputSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { body, handler, json } from '@/lib/http';
import { readOwn, saveOwn } from '@/lib/services/storage';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const user = await requireUser();
  return json(await readOwn(user.id));
});

export const PUT = handler(async (request) => {
  const user = await requireUser();
  const input = await body(request, workspaceStorageInputSchema);
  return json(await saveOwn(user.id, input));
});
