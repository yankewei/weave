import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { currentUser } from '@/lib/auth';
import { listWorkspaces } from '@/lib/services/workspaces';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const user = await currentUser();
  if (!user) redirect('/login');
  const workspaces = await listWorkspaces(user.id);
  if (!workspaces.some((workspace) => workspace.id === workspaceId))
    redirect('/');
  return (
    <AppShell user={user} workspaces={workspaces} workspaceId={workspaceId}>
      {children}
    </AppShell>
  );
}
