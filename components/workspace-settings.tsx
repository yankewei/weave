'use client';

import { useState } from 'react';
import type { User, WorkspaceMember } from '@/lib/contracts';
import { useLeaveWorkspace } from '@/lib/current-user';
import { useWorkspaces } from '@/lib/workspace-list';
import { WorkspaceMembers } from '@/components/workspace-members';
import { WorkspaceStorage } from '@/components/workspace-storage';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function WorkspaceSettings({
  workspaceId,
  user,
}: {
  workspaceId: string;
  user: User;
}) {
  const leaveWorkspace = useLeaveWorkspace();
  const [viewerRole, setViewerRole] = useState<WorkspaceMember['role'] | null>(
    null,
  );
  const workspaceName =
    useWorkspaces().find((item) => item.id === workspaceId)?.name ??
    '这个工作空间';
  return (
    <section
      className="mx-auto flex h-full w-full max-w-3xl flex-col gap-10 overflow-y-auto px-6 py-12"
      aria-label="工作空间设置"
    >
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-medium tracking-tight">设置</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          工作空间名称下面是成员和图片存储。管理员可以邀请已经注册的账号。
        </p>
      </div>
      <section
        className="flex flex-col gap-4"
        aria-labelledby="settings-workspace-name"
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">工作空间</p>
          <h2
            id="settings-workspace-name"
            className="text-lg font-medium tracking-tight"
          >
            {workspaceName}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {`成员和存储都属于${workspaceName}。切换工作空间后，这里换成另一个工作空间的内容。`}
          </p>
        </div>
        <WorkspaceMembers
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          user={user}
          onLeft={leaveWorkspace}
          onRoleChange={setViewerRole}
        />
        {viewerRole === 'admin' ? (
          <WorkspaceStorage
            workspaceId={workspaceId}
            workspaceName={workspaceName}
          />
        ) : viewerRole === 'member' ? (
          <Card>
            <CardHeader>
              <CardTitle>{workspaceName}的存储</CardTitle>
              <CardDescription>
                只有管理员可以查看和配置工作空间存储。
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}
      </section>
    </section>
  );
}
