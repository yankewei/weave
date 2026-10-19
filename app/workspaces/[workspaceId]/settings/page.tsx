import { WorkspaceView } from '@/components/workspace-view';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <WorkspaceView workspaceId={workspaceId} view="settings" />;
}
