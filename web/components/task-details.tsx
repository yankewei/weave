import { useEffect, useState, type FormEvent } from 'react';
import {
  taskEventSchema,
  taskSchema,
  type Task,
  type TaskInput,
  type TaskStatus,
  type ProjectMember,
  type TaskEvent,
} from '@/lib/contracts';
import { AlertCircleIcon, CheckIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import {
  taskFieldLabels,
  taskHistoryValue,
  taskPriorityLabels,
  taskStatusLabels,
  taskStatuses,
} from '@/lib/task-ui';
import { TaskComments } from '@/components/task-comments';
import { useConfirmation } from '@/hooks/use-confirmation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { taskKey } from '@/lib/references';
import { ReferencedKeys, ReferenceText } from '@/components/reference-text';

export function TaskDetails({
  projectId,
  task,
  initialStatus,
  members,
  currentUserId,
  onClose,
  onCommitted,
  onDirtyChange,
  onBusyChange,
}: {
  projectId: string;
  task: Task | null;
  initialStatus: TaskStatus;
  members: ProjectMember[];
  currentUserId: string;
  onClose: () => void;
  onCommitted: (task: Task) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const original: TaskInput = task
    ? {
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        priority: task.priority,
        status: task.status,
        assigneeId: task.assigneeId,
      }
    : {
        title: '',
        description: '',
        acceptanceCriteria: '',
        priority: 'normal',
        status: initialStatus,
        assigneeId: null,
      };
  const [draft, setDraft] = useState<TaskInput>(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [history, setHistory] = useState<TaskEvent[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(Boolean(task));
  const [retry, setRetry] = useState(0);
  const { confirm, confirmationDialog } = useConfirmation();
  const dirty = (Object.keys(taskFieldLabels) as (keyof TaskInput)[]).some(
    (field) => draft[field] !== original[field],
  );
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    api(`/tasks/${task.id}/history`, taskEventSchema.array(), {
      signal: controller.signal,
    })
      .then(setHistory)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setHistoryError(
            error instanceof Error ? error.message : '历史加载失败。',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [task, retry]);

  async function close() {
    if (busy) return;
    if (
      dirty &&
      !(await confirm({
        title: '放弃任务草稿？',
        description: '未保存的任务修改将丢失。',
        confirmLabel: '放弃修改',
      }))
    )
      return;
    onDirtyChange(false);
    onClose();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || conflict) return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      const updated = await api(
        task ? `/tasks/${task.id}` : `/projects/${projectId}/tasks`,
        taskSchema,
        {
          method: task ? 'PUT' : 'POST',
          body: JSON.stringify({
            ...draft,
            ...(task ? { baseVersion: task.version } : {}),
          }),
        },
      );
      setDraft(updated);
      onDirtyChange(false);
      await onCommitted(updated);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : '保存失败，草稿已保留。',
      );
      setConflict(error instanceof ApiError && error.status === 409);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        <SheetContent className="w-full sm:max-w-xl" showCloseButton={!busy}>
          <SheetHeader>
            <SheetTitle>
              {task ? `${taskKey(task.number)} · 任务详情` : '创建任务'}
            </SheetTitle>
            <SheetDescription>
              {task
                ? '编辑任务信息，或查看状态流转与字段变更历史。'
                : '记录要完成的工作和验收标准，加入当前项目的看板。'}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>
                  {conflict ? '任务版本发生冲突' : '任务未保存'}
                </AlertTitle>
                <AlertDescription>
                  <p>{error}</p>
                  {conflict && (
                    <p>
                      请先复制需要保留的草稿，关闭详情并刷新看板后重新打开。
                    </p>
                  )}
                </AlertDescription>
              </Alert>
            )}
            <form
              id="task-form"
              onSubmit={(event) => {
                void save(event);
              }}
            >
              <FieldGroup>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="task-title">任务标题</FieldLabel>
                  <Input
                    id="task-title"
                    value={draft.title}
                    onChange={(event) =>
                      setDraft({ ...draft, title: event.target.value })
                    }
                    required
                    maxLength={200}
                    disabled={busy}
                    autoFocus
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field data-disabled={busy}>
                    <FieldLabel htmlFor="task-status">状态</FieldLabel>
                    <NativeSelect
                      id="task-status"
                      className="w-full"
                      value={draft.status}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          status: event.target.value as TaskStatus,
                        })
                      }
                      disabled={busy}
                    >
                      {taskStatuses.map((status) => (
                        <NativeSelectOption key={status} value={status}>
                          {taskStatusLabels[status]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field data-disabled={busy}>
                    <FieldLabel htmlFor="task-priority">优先级</FieldLabel>
                    <NativeSelect
                      id="task-priority"
                      className="w-full"
                      value={draft.priority}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          priority: event.target.value as TaskInput['priority'],
                        })
                      }
                      disabled={busy}
                    >
                      {Object.entries(taskPriorityLabels).map(
                        ([value, label]) => (
                          <NativeSelectOption key={value} value={value}>
                            {label}
                          </NativeSelectOption>
                        ),
                      )}
                    </NativeSelect>
                  </Field>
                </div>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="task-assignee">负责人</FieldLabel>
                  <NativeSelect
                    id="task-assignee"
                    className="w-full"
                    value={draft.assigneeId ?? ''}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        assigneeId: event.target.value || null,
                      })
                    }
                    disabled={busy}
                  >
                    <NativeSelectOption value="">未分配</NativeSelectOption>
                    {members.map((member) => (
                      <NativeSelectOption key={member.id} value={member.id}>
                        {member.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="task-description">描述</FieldLabel>
                  <Textarea
                    id="task-description"
                    className="min-h-28"
                    value={draft.description}
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                    maxLength={20_000}
                    disabled={busy}
                    placeholder="要解决什么问题？需要完成哪些工作？"
                  />
                  <ReferencedKeys text={draft.description} />
                </Field>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="task-acceptance">验收标准</FieldLabel>
                  <Textarea
                    id="task-acceptance"
                    className="min-h-24"
                    value={draft.acceptanceCriteria}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        acceptanceCriteria: event.target.value,
                      })
                    }
                    maxLength={20_000}
                    disabled={busy}
                    placeholder="怎样判断这项任务已经完成？"
                  />
                  <ReferencedKeys text={draft.acceptanceCriteria} />
                  <FieldDescription>
                    所有正式修改都会保留历史。对话创建的任务会标出来源提案。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </form>
            {task && (
              <>
                <Separator />
                <TaskComments taskId={task.id} currentUserId={currentUserId} />
                <Separator />
                <section
                  aria-label="任务变更历史"
                  className="flex flex-col gap-4"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">变更历史</h3>
                    <Badge variant="outline">v{task.version}</Badge>
                  </div>
                  {historyLoading && <Skeleton className="h-24 w-full" />}
                  {historyError && (
                    <Alert variant="destructive">
                      <AlertTitle>历史加载失败</AlertTitle>
                      <AlertDescription>
                        <p>{historyError}</p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setHistoryError('');
                            setHistoryLoading(true);
                            setRetry(retry + 1);
                          }}
                        >
                          重试历史加载
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  {history.map((event) => (
                    <Card key={event.operationId} size="sm">
                      <CardHeader>
                        <CardTitle>
                          {event.kind === 'create'
                            ? event.proposalId
                              ? '确认 AI 提案'
                              : '创建任务'
                            : event.kind === 'move'
                              ? '移动任务'
                              : '编辑任务'}{' '}
                          · v{event.version}
                        </CardTitle>
                        <CardDescription>
                          {event.actorName} ·{' '}
                          {new Date(event.createdAt).toLocaleString('zh-CN')}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <dl className="flex flex-col gap-3 text-xs">
                          {(Object.keys(taskFieldLabels) as (keyof TaskInput)[])
                            .filter(
                              (field) =>
                                !event.before ||
                                event.before[field] !== event.after[field],
                            )
                            .map((field) => (
                              <div key={field}>
                                <dt className="mb-1 font-medium">
                                  {taskFieldLabels[field]}
                                </dt>
                                <dd className="whitespace-pre-wrap wrap-anywhere">
                                  <span className="text-muted-foreground">
                                    <ReferenceText
                                      text={taskHistoryValue(
                                        event.before,
                                        field,
                                      )}
                                    />
                                  </span>
                                  {' → '}
                                  <ReferenceText
                                    text={taskHistoryValue(event.after, field)}
                                  />
                                </dd>
                              </div>
                            ))}
                          {event.kind === 'move' &&
                            event.before?.status === event.after.status && (
                              <div>
                                <dt>列内排序</dt>
                                <dd>
                                  调整了任务在「
                                  {taskStatusLabels[event.after.status]}
                                  」中的顺序。
                                </dd>
                              </div>
                            )}
                        </dl>
                      </CardContent>
                    </Card>
                  ))}
                </section>
              </>
            )}
          </div>
          <SheetFooter>
            <Button
              type="submit"
              form="task-form"
              disabled={busy || conflict || Boolean(task && !dirty)}
            >
              {busy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CheckIcon data-icon="inline-start" />
              )}
              {task ? '保存任务' : '创建任务'}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void close();
              }}
            >
              关闭详情
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {confirmationDialog}
    </>
  );
}
