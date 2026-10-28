import { useEffect, useState } from 'react';
import { AlertCircleIcon, KanbanIcon } from 'lucide-react';
import { taskSchema, type Task, type TaskStatus } from '@/lib/contracts';
import { api } from '@/lib/api';
import { taskPriorityLabels, taskStatusLabels } from '@/lib/task-ui';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { taskKey } from '@/lib/references';

const panelStatuses: TaskStatus[] = ['in_progress', 'todo'];
const emptyHints: Record<TaskStatus, string> = {
  in_progress: '把待办拖到进行中后会出现在这里。',
  todo: '确认对话里的任务提案后，任务会出现在这里。',
  done: '',
};

// Read-only view of the project's open work beside the conversation; edits stay on the board.
export function TaskPanel({
  projectId,
  projectName,
  currentUserId,
  refreshKey,
  onOpenBoard,
}: {
  projectId: string;
  projectName: string;
  currentUserId: string;
  refreshKey: number;
  onOpenBoard: () => void;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>('all');

  useEffect(() => {
    const controller = new AbortController();
    api(`/projects/${projectId}/tasks`, taskSchema.array(), {
      signal: controller.signal,
    })
      .then((items) => {
        setTasks(items);
        setError('');
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : '任务加载失败。');
      });
    return () => controller.abort();
  }, [projectId, refreshKey]);

  const visible =
    scope === 'mine'
      ? tasks?.filter((task) => task.assigneeId === currentUserId)
      : tasks;

  return (
    <aside
      className="flex min-w-0 flex-col gap-3 lg:w-80 lg:shrink-0"
      aria-label={`${projectName}的任务`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">进行中与待办</h2>
        <ToggleGroup
          aria-label="任务范围"
          variant="outline"
          size="sm"
          spacing={0}
          value={[scope]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === 'all' || next === 'mine') setScope(next);
          }}
        >
          <ToggleGroupItem value="all">全部</ToggleGroupItem>
          <ToggleGroupItem value="mine">我的</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>任务未加载</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {panelStatuses.map((status) => {
        const items = visible?.filter((task) => task.status === status);
        return (
          <Card key={status} size="sm" className="min-h-0 lg:flex-1">
            <CardHeader>
              <CardTitle>
                <h3>{taskStatusLabels[status]}</h3>
              </CardTitle>
              <CardAction>
                <Badge variant="secondary">{items?.length ?? 0}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto">
              {!items && !error ? (
                <div className="flex flex-col gap-2" role="status">
                  <span className="sr-only">正在加载任务…</span>
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-3/4" />
                </div>
              ) : null}
              {items?.length === 0 ? (
                <Empty className="p-2">
                  <EmptyHeader>
                    <EmptyTitle>没有{taskStatusLabels[status]}任务</EmptyTitle>
                    <EmptyDescription>
                      {scope === 'mine'
                        ? '分给你的任务会出现在这里。'
                        : emptyHints[status]}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {items?.length ? (
                <ul className="flex flex-col">
                  {items.map((task) => (
                    <li
                      key={task.id}
                      className="flex min-w-0 flex-col gap-1 border-b py-2 first:pt-0 last:border-b-0 last:pb-0"
                    >
                      <p className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {taskKey(task.number)}
                        </span>
                        <span className="truncate font-medium">
                          {task.title}
                        </span>
                      </p>
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge variant="outline">
                          {taskPriorityLabels[task.priority]}优先级
                        </Badge>
                        <span className="truncate text-xs text-muted-foreground">
                          {task.assigneeName ?? '未分配'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
      <Button variant="outline" size="sm" onClick={onOpenBoard}>
        <KanbanIcon data-icon="inline-start" />
        在看板中查看全部
      </Button>
    </aside>
  );
}
