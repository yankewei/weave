'use client';

import { useCallback, useEffect, useState, type Ref } from 'react';
import { AlertCircleIcon, FileTextIcon } from 'lucide-react';
import {
  workspaceOverviewSchema,
  type User,
  type WorkspaceOverview,
} from '@/lib/contracts';
import { api } from '@/lib/api';
import { taskStatusLabels } from '@/lib/task-ui';
import {
  TaskConversation,
  type TaskConversationHandle,
} from '@/components/task-conversation';
import { TaskPanel } from '@/components/task-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { taskKey } from '@/lib/references';

type Activity = WorkspaceOverview['activity'][number];

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function describeActivity(item: Activity) {
  if (item.kind === 'document') {
    if (item.action === 'restore') return `恢复了《${item.title}》`;
    return `${item.action === 'create' ? '创建了' : '编辑了'}《${item.title}》`;
  }
  const task = item.taskNumber
    ? `${taskKey(item.taskNumber)} ${item.title}`
    : item.title;
  if (item.action === 'move' && item.taskStatus)
    return `把 ${task} 移到${taskStatusLabels[item.taskStatus]}`;
  if (item.action === 'create')
    return item.fromProposal
      ? `确认 AI 提案，创建了 ${task}`
      : `创建了 ${task}`;
  return `更新了 ${task}`;
}

// The project home: the conversation and the project's open work side by side,
// with a workspace-wide summary below it.
export function Workbench({
  workspaceId,
  projectId,
  projectName,
  user,
  conversationRef,
  onOpenBoard,
  onOpenProject,
  onOpenDocument,
}: {
  workspaceId: string;
  projectId: string;
  projectName: string;
  user: User;
  conversationRef: Ref<TaskConversationHandle>;
  onOpenBoard: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenDocument: (projectId: string, documentId: string) => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [overview, setOverview] = useState<WorkspaceOverview | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    api(`/workspaces/${workspaceId}/overview`, workspaceOverviewSchema, {
      signal: controller.signal,
    })
      .then((value) => {
        setOverview(value);
        setError('');
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error ? caught.message : '工作空间概况加载失败。',
          );
      });
    return () => controller.abort();
  }, [workspaceId, refreshKey]);

  const pending =
    overview?.projects.reduce(
      (sum, project) => sum + project.pendingProposals,
      0,
    ) ?? 0;
  const current = overview?.projects.find(
    (project) => project.id === projectId,
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">你好，{user.name}</h1>
        <p className="text-sm text-muted-foreground">
          {overview
            ? `${pending ? `${pending} 份提案等你确认` : '没有等你确认的提案'} · ${projectName}有 ${current?.inProgress ?? 0} 个任务进行中`
            : '正在汇总工作空间…'}
        </p>
      </header>

      <div className="flex flex-col gap-4 lg:h-[min(44rem,calc(100svh-12rem))] lg:flex-row">
        <Card className="h-[36rem] min-w-0 gap-0 py-0 lg:h-auto lg:flex-1">
          <TaskConversation
            ref={conversationRef}
            placement="page"
            projectId={projectId}
            projectName={projectName}
            onOpenBoard={onOpenBoard}
            onStateChange={refresh}
          />
        </Card>
        <TaskPanel
          projectId={projectId}
          projectName={projectName}
          currentUserId={user.id}
          refreshKey={refreshKey}
          onOpenBoard={onOpenBoard}
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>概况未加载</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={refresh}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="bench-projects">
        <h2 id="bench-projects" className="text-sm font-medium">
          项目
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {!overview && !error ? (
            <>
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </>
          ) : null}
          {overview?.projects.map((project) => (
            <Card key={project.id} size="sm">
              <CardHeader>
                <CardTitle>
                  <h3>{project.name}</h3>
                </CardTitle>
                <CardDescription>
                  待办 {project.todo} · 进行中 {project.inProgress} · 已完成{' '}
                  {project.done} · {project.documents} 篇文档
                </CardDescription>
                {project.pendingProposals ? (
                  <CardAction>
                    <Badge>{project.pendingProposals} 份待确认</Badge>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardFooter>
                {project.id === projectId ? (
                  <Badge variant="secondary">当前项目</Badge>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenProject(project.id)}
                  >
                    打开
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>最近文档</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!overview && !error ? <Skeleton className="h-24 w-full" /> : null}
            {overview?.documents.length === 0 ? (
              <Empty className="p-2">
                <EmptyHeader>
                  <EmptyTitle>还没有文档</EmptyTitle>
                  <EmptyDescription>
                    在侧栏的文档分组里新建一篇。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {overview?.documents.length ? (
              <ul className="flex flex-col gap-1">
                {overview.documents.map((item) => (
                  <li key={item.id}>
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start py-2"
                      onClick={() => onOpenDocument(item.projectId, item.id)}
                    >
                      <FileTextIcon data-icon="inline-start" />
                      <span className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="w-full truncate text-left">
                          {item.title}
                        </span>
                        <span className="w-full truncate text-left text-xs font-normal text-muted-foreground">
                          {item.projectName} · {item.updatedByName} 编辑于{' '}
                          {formatTime(item.updatedAt)}
                        </span>
                      </span>
                      <Badge variant="outline">v{item.version}</Badge>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>最近动态</h2>
            </CardTitle>
            <CardDescription>来自任务与文档的变更历史</CardDescription>
          </CardHeader>
          <CardContent>
            {!overview && !error ? <Skeleton className="h-24 w-full" /> : null}
            {overview?.activity.length === 0 ? (
              <Empty className="p-2">
                <EmptyHeader>
                  <EmptyTitle>还没有变更</EmptyTitle>
                  <EmptyDescription>
                    文档版本和任务变更会按时间出现在这里。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {overview?.activity.length ? (
              <ol className="flex flex-col">
                {overview.activity.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-0.5 border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
                  >
                    <p className="text-sm">
                      <span className="font-medium">{item.actorName}</span>{' '}
                      {describeActivity(item)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.projectName} ·{' '}
                      <time dateTime={item.createdAt}>
                        {formatTime(item.createdAt)}
                      </time>
                    </p>
                  </li>
                ))}
              </ol>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
