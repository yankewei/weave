import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { listWorkspaces } from '@/lib/services/workspaces';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  const workspaces = await listWorkspaces(user.id);
  const first = workspaces[0];
  if (!first) {
    return (
      <main className="p-8 text-sm text-muted-foreground">
        你暂时没有可访问的工作空间。
      </main>
    );
  }
  redirect(`/workspaces/${first.id}`);
}
