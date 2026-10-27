import { redirect } from 'next/navigation';
import { SearchXIcon } from 'lucide-react';
import { currentUser } from '@/lib/auth';
import { locate } from '@/lib/services/references';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

export const dynamic = 'force-dynamic';

export default async function BrowsePage({
  params,
}: {
  params: Promise<{ workspaceId: string; key: string }>;
}) {
  const { workspaceId, key } = await params;
  const user = await currentUser();
  if (!user) redirect('/login');
  const decoded = decodeURIComponent(key);
  const path = await locate(user.id, workspaceId, decoded);
  if (path) redirect(path);
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>找不到 {decoded.toUpperCase()}</EmptyTitle>
        <EmptyDescription>
          这个编号在当前工作空间里没有对应的任务或文档。
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
