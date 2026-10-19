import { WorkspaceView } from '@/components/workspace-view';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  return (
    <WorkspaceView
      workspaceId={workspaceId}
      projectId={projectId}
      view="conversation"
    />
  );
}
