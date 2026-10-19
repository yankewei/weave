import { WorkspaceView } from '@/components/workspace-view';

export const dynamic = 'force-dynamic';

export default async function DocumentPage({
  params,
}: {
  params: Promise<{
    workspaceId: string;
    projectId: string;
    documentId: string;
  }>;
}) {
  const { workspaceId, projectId, documentId } = await params;
  return (
    <WorkspaceView
      workspaceId={workspaceId}
      projectId={projectId}
      documentId={documentId}
      view="document"
    />
  );
}
