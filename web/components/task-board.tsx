import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  projectMemberSchema,
  taskSchema,
  type ProjectMember,
  type Task,
  type TaskStatus,
} from '@/lib/contracts';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertCircleIcon,
  CheckIcon,
  GripVerticalIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { TaskDetails } from '@/components/task-details';
import {
  taskPriorityLabels,
  taskStatusLabels,
  taskStatuses,
} from '@/lib/task-ui';
import { cn } from '@/lib/utils';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { taskKey } from '@/lib/references';

export function TaskBoard({
  projectId,
  projectName,
  currentUserId,
  onDirtyChange,
  onBusyChange,
}: {
  projectId: string;
  projectName: string;
  currentUserId: string;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [editing, setEditing] = useState<{
    task: Task | null;
    status: TaskStatus;
  } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // DEV-n links land here with ?task=<id> so the task opens on arrival.
  const [searchParams] = useSearchParams();
  const requestedTaskId = searchParams.get('task');
  const writing = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api(`/projects/${projectId}/tasks`, taskSchema.array(), {
        signal: controller.signal,
      }),
      api(`/projects/${projectId}/members`, projectMemberSchema.array(), {
        signal: controller.signal,
      }),
    ])
      .then(([tasks, members]) => {
        setTasks(tasks);
        setMembers(members);
        const requested = tasks.find((task) => task.id === requestedTaskId);
        if (requested)
          setEditing({ task: requested, status: requested.status });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '看板加载失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, retry, requestedTaskId]);

  const filtered = tasks.filter((task) => {
    const text = query.trim().toLocaleLowerCase();
    return (
      (!text ||
        `${task.title}\n${task.description}\n${taskKey(task.number)}`
          .toLocaleLowerCase()
          .includes(text)) &&
      (priority === 'all' || task.priority === priority) &&
      (assignee === 'all' ||
        (assignee === 'unassigned' && !task.assigneeId) ||
        task.assigneeId === (assignee === 'mine' ? currentUserId : assignee))
    );
  });
  const active = tasks.find((task) => task.id === activeId);

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null,
  ) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    let committed = false;
    try {
      await api(`/tasks/${task.id}/move`, taskSchema, {
        method: 'POST',
        body: JSON.stringify({
          baseVersion: task.version,
          status,
          beforeTaskId,
        }),
      });
      committed = true;
      setTasks(await api(`/projects/${projectId}/tasks`, taskSchema.array()));
      setNotice(
        `${taskKey(task.number)} 已移至「${taskStatusLabels[status]}」，顺序已保存。`,
      );
    } catch (error) {
      setError(
        committed
          ? '任务已移动，但看板刷新失败，请刷新看板获取最新状态。'
          : error instanceof Error
            ? error.message
            : '移动失败，看板未改变，请重试。',
      );
    } finally {
      writing.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  function finishDrag({ active, over }: DragEndEvent) {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const task = tasks.find((task) => task.id === active.id);
    if (!task) return;
    const target = tasks.find((task) => task.id === over.id);
    const status =
      target?.status ??
      (taskStatuses.includes(over.id as TaskStatus)
        ? (over.id as TaskStatus)
        : null);
    if (!status) return;
    let beforeTaskId = target?.id ?? null;
    if (target && task.status === status) {
      const column = tasks.filter((item) => item.status === status);
      if (
        column.findIndex((item) => item.id === task.id) <
        column.findIndex((item) => item.id === target.id)
      )
        beforeTaskId =
          column[column.findIndex((item) => item.id === target.id) + 1]?.id ??
          null;
    }
    void moveTask(task, status, beforeTaskId);
  }

  async function committed(task: Task) {
    setEditing({ task, status: task.status });
    onDirtyChange(false);
    setNotice(`${taskKey(task.number)} 已保存。`);
    try {
      setTasks(await api(`/projects/${projectId}/tasks`, taskSchema.array()));
    } catch {
      setError('任务已保存，但看板刷新失败，请刷新看板。');
    }
  }

  const doneCount = tasks.filter((task) => task.status === 'done').length;
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6"
      aria-label="任务看板"
    >
      <header className="flex shrink-0 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              {projectName} / 执行与交付
            </p>
            <h1 className="text-lg font-medium">任务看板</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-muted-foreground">
              {doneCount} / {tasks.length} 已完成
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || loading}
              onClick={() => {
                setError('');
                setLoading(true);
                setRetry(retry + 1);
              }}
            >
              <RefreshCwIcon data-icon="inline-start" />
              刷新看板
            </Button>
            <Button
              size="sm"
              disabled={busy || loading || Boolean(error && !tasks.length)}
              onClick={() => setEditing({ task: null, status: 'todo' })}
            >
              <PlusIcon data-icon="inline-start" />
              创建任务
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <ToggleGroup
            aria-label="优先级筛选"
            variant="outline"
            size="sm"
            spacing={0}
            value={[priority]}
            onValueChange={(values) => {
              const next = values[0];
              if (next) setPriority(next);
            }}
          >
            <ToggleGroupItem value="all">全部</ToggleGroupItem>
            {Object.entries(taskPriorityLabels).map(([value, label]) => (
              <ToggleGroupItem key={value} value={value}>
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldGroup className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(12rem,1fr)_12rem]">
            <Field>
              <FieldLabel htmlFor="board-search" className="sr-only">
                搜索任务
              </FieldLabel>
              <Input
                id="board-search"
                placeholder="搜索标题、描述或编号…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="board-assignee" className="sr-only">
                负责人筛选
              </FieldLabel>
              <NativeSelect
                id="board-assignee"
                className="w-full"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
              >
                <NativeSelectOption value="all">全部负责人</NativeSelectOption>
                <NativeSelectOption value="mine">我负责的</NativeSelectOption>
                <NativeSelectOption value="unassigned">
                  未分配
                </NativeSelectOption>
                {members.map((member) => (
                  <NativeSelectOption key={member.id} value={member.id}>
                    {member.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </FieldGroup>
        </div>
      </header>
      {error ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>看板需要检查</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <CheckIcon />
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      ) : null}
      <div className="flex shrink-0 items-center justify-end gap-2 text-xs text-muted-foreground">
        {busy ? (
          <span className="flex items-center gap-2" role="status">
            <Spinner />
            正在保存…
          </span>
        ) : (
          <p>
            显示 {filtered.length} / {tasks.length} 项
          </p>
        )}
      </div>
      {loading ? (
        <div
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto"
          role="status"
          aria-label="正在加载看板"
        >
          {taskStatuses.map((status) => (
            <Skeleton className="h-full min-w-72 flex-1" key={status} />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={(args) => {
            const collisions = pointerWithin(args);
            return collisions.length ? collisions : closestCenter(args);
          }}
          onDragStart={({ active }) => {
            setNotice('');
            setActiveId(String(active.id));
          }}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={finishDrag}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                '按空格键开始拖动，方向键移动，空格键放下，Escape 取消。也可以打开任务详情修改状态。',
            },
          }}
        >
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
            {taskStatuses.map((status) => (
              <BoardColumn
                key={status}
                status={status}
                tasks={filtered.filter((task) => task.status === status)}
                total={tasks.filter((task) => task.status === status).length}
                busy={busy || Boolean(error && !tasks.length)}
                onCreate={() => setEditing({ task: null, status })}
                onOpen={(task) => setEditing({ task, status: task.status })}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {active ? (
              <Card size="sm">
                <CardHeader>
                  <CardTitle>{active.title}</CardTitle>
                  <CardDescription>
                    {taskKey(active.number)} ·{' '}
                    {taskPriorityLabels[active.priority]}
                    优先级
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
      {editing ? (
        <TaskDetails
          key={`${editing.task?.id ?? 'new'}-${editing.task?.version ?? editing.status}`}
          projectId={projectId}
          task={editing.task}
          initialStatus={editing.status}
          members={members}
          currentUserId={currentUserId}
          onClose={() => setEditing(null)}
          onCommitted={committed}
          onDirtyChange={onDirtyChange}
          onBusyChange={(writing) => {
            setBusy(writing);
            onBusyChange(writing);
          }}
        />
      ) : null}
    </section>
  );
}

function BoardColumn({
  status,
  tasks,
  total,
  busy,
  onCreate,
  onOpen,
}: {
  status: TaskStatus;
  tasks: Task[];
  total: number;
  busy: boolean;
  onCreate: () => void;
  onOpen: (task: Task) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled: busy });
  const label = taskStatusLabels[status];
  return (
    <section
      className="flex h-full min-w-72 flex-1 flex-col gap-3 rounded-xl bg-muted p-3"
      role="region"
      aria-label={`${label}列`}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 px-1">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {label}
          <Badge variant="secondary">
            {tasks.length === total ? total : `${tasks.length}/${total}`}
          </Badge>
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`在${label}创建任务`}
          disabled={busy}
          onClick={onCreate}
        >
          <PlusIcon />
        </Button>
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto',
          isOver && 'rounded-lg outline-2 outline-dashed outline-ring',
        )}
      >
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              busy={busy}
              onOpen={() => onOpen(task)}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 ? (
          <Empty className="min-h-40 flex-1">
            <EmptyHeader>
              <EmptyTitle>{total ? '没有匹配的任务' : '还没有任务'}</EmptyTitle>
              <EmptyDescription>
                {total
                  ? '调整筛选，或把其他任务拖到这里。'
                  : status === 'todo'
                    ? '从列头新建，或在对话里确认提案。'
                    : '把任务拖到这里。'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  busy,
  onOpen,
}: {
  task: Task;
  busy: boolean;
  onOpen: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: busy });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('shrink-0', isDragging && 'opacity-40')}
    >
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <Button
              variant="link"
              className="h-auto justify-start p-0 text-left whitespace-normal"
              disabled={busy}
              onClick={onOpen}
            >
              {task.title}
            </Button>
          </CardTitle>
          <CardDescription>{taskKey(task.number)}</CardDescription>
          <CardAction>
            <Button
              ref={setActivatorNodeRef}
              variant="ghost"
              size="icon-xs"
              className="touch-none"
              {...attributes}
              {...listeners}
              aria-label={`拖动 ${taskKey(task.number)}`}
              disabled={busy}
            >
              <GripVerticalIcon />
            </Button>
          </CardAction>
        </CardHeader>
        {task.description || task.acceptanceCriteria ? (
          <CardContent className="flex flex-col gap-2">
            {task.description ? (
              <p className="line-clamp-2 text-sm wrap-anywhere text-muted-foreground">
                {task.description}
              </p>
            ) : null}
            {task.acceptanceCriteria ? (
              <p className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
                验收：{task.acceptanceCriteria}
              </p>
            ) : null}
          </CardContent>
        ) : null}
        <CardFooter className="justify-between gap-2">
          <Badge variant="outline">
            {taskPriorityLabels[task.priority]}优先级
          </Badge>
          <span className="truncate text-xs text-muted-foreground">
            {task.assigneeName ?? '未分配'}
          </span>
        </CardFooter>
      </Card>
    </div>
  );
}
