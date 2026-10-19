import { requireUser } from '@/lib/auth';
import { json, handler } from '@/lib/http';
import { listWorkspaces } from '@/lib/services/workspaces';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const user = await requireUser();
  return json(await listWorkspaces(user.id));
});
