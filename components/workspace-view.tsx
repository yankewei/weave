'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  documentSchema,
  documentSummarySchema,
  projectSchema,
  type Document,
  type DocumentSummary,
  type Project,
} from '@/lib/contracts';
import {
  AlertCircleIcon,
  FileTextIcon,
  FolderIcon,
  PlusIcon,
  SparklesIcon,
  KanbanIcon,
  SettingsIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/current-user';
import {
  ConversationStarterCards,
  IdeaComposer,
} from '@/components/conversation-start';
import { DocumentEditor } from '@/components/document-editor';
import { TaskBoard } from '@/components/task-board';
import {
  TaskConversation,
  type TaskConversationHandle,
} from '@/components/task-conversation';
import { WorkspaceSettings } from '@/components/workspace-settings';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmation } from '@/hooks/use-confirmation';

export type WorkspaceViewKind =
  'conversation' | 'board' | 'document' | 'settings';

export function WorkspaceView({
  workspaceId,
  projectId = '',
  documentId = '',
  view,
}: {
  workspaceId: string;
  projectId?: string;
  documentId?: string;
  view: WorkspaceViewKind;
}) {
  const router = useRouter();
  const user = useCurrentUser();
  const board = view === 'board';
  const settings = view === 'settings';
  const [chatOpen, setChatOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [documentList, setDocumentList] = useState<{
    projectId: string;
    documents: DocumentSummary[];
  }>({ projectId: '', documents: [] });
  const documents =
    documentList.projectId === projectId ? documentList.documents : [];
  const [loadedDocument, setLoadedDocument] = useState<Document | null>(null);
  const document = loadedDocument?.id === documentId ? loadedDocument : null;
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creation, setCreation] = useState<'project' | 'document' | null>(null);
  const [retry, setRetry] = useState(0);
  const { confirm, confirmationDialog } = useConfirmation();
  const { setOpenMobile } = useSidebar();
  const dirtyRef = useRef(false);
  const documentListVersion = useRef(0);
  const conversationRef = useRef<TaskConversationHandle>(null);
  const [idea, setIdea] = useState('');
  const setPageDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);

  // Client navigation replaces the router blocker: ask before dropping a draft.
  const guard = useCallback(
    async (path: string, replace = false) => {
      if (dirtyRef.current) {
        const prompt = leavePrompt(path);
        const accepted = await confirm(prompt);
        if (!accepted) return;
      }
      if (replace) router.replace(path);
      else router.push(path);
    },
    [confirm, router],
  );

  useEffect(() => {
    const controller = new AbortController();
    api(`/workspaces/${workspaceId}/projects`, projectSchema.array(), {
      signal: controller.signal,
    })
      .then(setProjects)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '项目加载失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, retry]);
  useEffect(() => {
    if (loading || projectId || settings || projects.length === 0) return;
    const first = projects[0];
    if (!first) return;
    router.replace(`/workspaces/${workspaceId}/projects/${first.id}`);
  }, [loading, projectId, projects, router, settings, workspaceId]);
  useEffect(() => {
    if (!projectId) return;
    const version = documentListVersion.current;
    const controller = new AbortController();
    api(`/projects/${projectId}/documents`, documentSummarySchema.array(), {
      signal: controller.signal,
    })
      .then((items) => {
        if (
          controller.signal.aborted ||
          version !== documentListVersion.current
        )
          return;
        setDocumentList({ projectId, documents: items });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '文档加载失败。');
      });
    return () => controller.abort();
  }, [projectId, retry]);
  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    api(`/documents/${documentId}`, documentSchema, {
      signal: controller.signal,
    })
      .then(setLoadedDocument)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '打开文档失败。');
      });
    return () => controller.abort();
  }, [documentId, retry]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name'));
    if (
      dirty &&
      !(await confirm({
        title: '创建并切换项目？',
        description: '当前未保存的修改将丢失。',
        confirmLabel: '创建并切换',
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      const project = await api(
        `/workspaces/${workspaceId}/projects`,
        projectSchema,
        { method: 'POST', body: JSON.stringify({ name }) },
      );
      setPageDirty(false);
      setCreation(null);
      setOpenMobile(false);
      router.push(`/workspaces/${workspaceId}/projects/${project.id}`);
      setProjects((items) =>
        items.some((item) => item.id === project.id)
          ? items
          : [...items, project],
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '创建项目失败。');
    } finally {
      setBusy(false);
    }
  }
  async function createDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) return;
    const title = String(new FormData(event.currentTarget).get('title'));
    if (
      dirty &&
      !(await confirm({
        title: '创建并打开文档？',
        description: '当前未保存的修改将丢失。',
        confirmLabel: '创建并打开',
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      const item = await api(
        `/projects/${projectId}/documents`,
        documentSchema,
        { method: 'POST', body: JSON.stringify({ title, body: '' }) },
      );
      documentListVersion.current += 1;
      setDocumentList({ projectId, documents: [item, ...documents] });
      setLoadedDocument(item);
      setPageDirty(false);
      setCreation(null);
      setOpenMobile(false);
      router.push(
        `/workspaces/${workspaceId}/projects/${projectId}/documents/${item.id}`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '创建文档失败。');
    } finally {
      setBusy(false);
    }
  }
  function openSettings() {
    setOpenMobile(false);
    void guard(`/workspaces/${workspaceId}/settings`);
  }
  function openConversation() {
    setChatOpen(false);
    setOpenMobile(false);
    if (settings) {
      void guard(`/workspaces/${workspaceId}`);
      return;
    }
    if (!projectId || (!board && !documentId)) return;
    setError('');
    void guard(`/workspaces/${workspaceId}/projects/${projectId}`);
  }
  function submitWhenReady(body: string) {
    const started = performance.now();
    const tick = () => {
      const handle = conversationRef.current;
      if (handle?.ready) {
        handle.submit(body);
        return;
      }
      if (performance.now() - started < 10_000) setTimeout(tick, 16);
    };
    // The conversation view mounts after navigation. Wait until its history request finishes, then send.
    setTimeout(tick, 0);
  }
  async function beginFromIdea(body: string) {
    const name = projectNameFromIdea(body);
    if (!name) return;
    if (
      dirty &&
      !(await confirm({
        title: '创建并切换项目？',
        description: '当前未保存的修改将丢失。',
        confirmLabel: '创建并切换',
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      const project = await api(
        `/workspaces/${workspaceId}/projects`,
        projectSchema,
        { method: 'POST', body: JSON.stringify({ name }) },
      );
      setPageDirty(false);
      setOpenMobile(false);
      router.push(`/workspaces/${workspaceId}/projects/${project.id}`);
      setProjects((items) =>
        items.some((item) => item.id === project.id)
          ? items
          : [...items, project],
      );
      setIdea('');
      submitWhenReady(body);
    } catch (error) {
      setError(error instanceof Error ? error.message : '创建项目失败。');
    } finally {
      setBusy(false);
    }
  }
  function openDocument(id: string) {
    if (busy || !projectId) return;
    setOpenMobile(false);
    if (id === documentId) return;
    setError('');
    void guard(
      `/workspaces/${workspaceId}/projects/${projectId}/documents/${id}`,
    );
  }
  function openBoard() {
    if (busy || !projectId) return;
    setOpenMobile(false);
    void guard(`/workspaces/${workspaceId}/projects/${projectId}/board`);
  }

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar className="top-16 h-[calc(100svh-4rem)]" aria-label="项目与文档">
        <SidebarContent className="py-4">
          <SidebarGroup>
            <SidebarGroupLabel>AI 协作</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={!settings && !board && !documentId}
                    aria-describedby="ai-nav-status"
                    onClick={openConversation}
                  >
                    <SparklesIcon />
                    <span>AI 对话</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              <p
                id="ai-nav-status"
                className="px-2 py-1 text-xs text-muted-foreground"
              >
                {projectId
                  ? '确认后才会写入看板'
                  : '写下要做的事，就会创建项目'}
              </p>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>项目</SidebarGroupLabel>
            <SidebarGroupAction
              aria-label="新建项目"
              disabled={busy}
              onClick={() => {
                setError('');
                setCreation('project');
              }}
            >
              <PlusIcon />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu aria-label="项目列表">
                {projects.map((project) => (
                  <SidebarMenuItem key={project.id}>
                    <SidebarMenuButton
                      isActive={project.id === projectId}
                      aria-current={
                        project.id === projectId ? 'page' : undefined
                      }
                      disabled={busy}
                      onClick={() => {
                        if (project.id === projectId) return;
                        setCreation(null);
                        setError('');
                        setOpenMobile(false);
                        void guard(
                          `/workspaces/${workspaceId}/projects/${project.id}`,
                        );
                      }}
                    >
                      <FolderIcon />
                      <span>{project.name}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
              {loading && (
                <div className="flex flex-col gap-3 p-2" role="status">
                  <span className="sr-only">正在加载项目…</span>
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-3/4" />
                </div>
              )}
              {!loading && projects.length === 0 && (
                <p className="px-2 py-3 text-xs leading-6 text-muted-foreground">
                  写下要做的事，就会创建第一个项目。
                </p>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
          {projectId && (
            <>
              <SidebarSeparator />
              <SidebarGroup>
                <SidebarGroupLabel>文档 · {documents.length}</SidebarGroupLabel>
                <SidebarGroupAction
                  aria-label="新建文档"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setCreation('document');
                  }}
                >
                  <PlusIcon />
                </SidebarGroupAction>
                <SidebarGroupContent>
                  <SidebarMenu aria-label="文档列表">
                    {documents.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          className="pr-10"
                          isActive={documentId === item.id}
                          aria-current={
                            documentId === item.id ? 'page' : undefined
                          }
                          disabled={busy}
                          onClick={() => {
                            void openDocument(item.id);
                          }}
                        >
                          <FileTextIcon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge>v{item.version}</SidebarMenuBadge>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                  {documents.length === 0 && (
                    <p className="px-2 py-3 text-xs leading-6 text-muted-foreground">
                      项目里还没有文档。
                    </p>
                  )}
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          )}
        </SidebarContent>
        {projectId && (
          <SidebarGroup>
            <SidebarGroupLabel>执行与交付</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={board}
                    onClick={openBoard}
                    disabled={busy}
                  >
                    <KanbanIcon />
                    <span>任务看板</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>工作空间</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={settings} onClick={openSettings}>
                  <SettingsIcon />
                  <span>设置</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarFooter className="p-4">
          <p className="text-xs leading-6 text-muted-foreground">
            文档保留每次正式修改。
            <br />
            对话拆出的任务需确认后写入看板。
          </p>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset
        className={cn(
          'min-w-0',
          !documentId && 'h-[calc(100svh-4rem)] overflow-hidden',
        )}
      >
        {error && !creation && (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>操作未完成</AlertTitle>
              <AlertDescription>
                <p>{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setError('');
                    setRetry(retry + 1);
                  }}
                >
                  重试加载
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        {busy && (
          <div
            className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground"
            role="status"
          >
            <Spinner />
            正在处理…
          </div>
        )}
        {settings ? (
          <WorkspaceSettings
            key={workspaceId}
            workspaceId={workspaceId}
            user={user}
          />
        ) : board && projectId ? (
          <TaskBoard
            key={projectId}
            projectId={projectId}
            projectName={
              projects.find((project) => project.id === projectId)?.name ??
              '项目'
            }
            currentUserId={user.id}
            onDirtyChange={setPageDirty}
            onBusyChange={setBusy}
          />
        ) : document ? (
          <DocumentEditor
            key={document.id}
            document={document}
            navigationBusy={busy}
            onDirtyChange={setPageDirty}
            onBusyChange={setBusy}
            onSaved={(updated) => {
              setLoadedDocument(updated);
              setDocumentList((current) => ({
                projectId: current.projectId,
                documents: current.documents.map((item) =>
                  item.id === updated.id ? updated : item,
                ),
              }));
            }}
          />
        ) : documentId ? (
          error ? null : (
            <div className="p-6" role="status">
              <Skeleton className="h-96 w-full" />
            </div>
          )
        ) : projectId ? (
          <TaskConversation
            ref={conversationRef}
            key={projectId}
            placement="page"
            projectId={projectId}
            projectName={
              projects.find((project) => project.id === projectId)?.name ??
              '项目'
            }
            onOpenBoard={openBoard}
          />
        ) : (
          <section
            className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center gap-8 overflow-y-auto px-6 py-12"
            aria-label="AI 项目工作区"
          >
            <div className="flex flex-col gap-3">
              <h1 className="text-3xl font-medium tracking-tight">
                从一个想法，与 AI 开始。
              </h1>
              <p
                id="ai-availability"
                className="text-sm leading-6 text-muted-foreground"
              >
                描述要做的事。这会创建一个项目，并让 AI
                拆出待确认的任务。确认后才写入看板。
              </p>
            </div>
            <IdeaComposer
              id="idea-body"
              value={idea}
              onChange={setIdea}
              onSubmit={() => {
                void beginFromIdea(idea);
              }}
              disabled={busy || loading}
              sending={busy}
              large
            />
            <ConversationStarterCards
              disabled={busy || loading}
              onPick={(body) => {
                void beginFromIdea(body);
              }}
            />
          </section>
        )}
      </SidebarInset>
      <Dialog
        open={creation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setCreation(null);
            setError('');
          }
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {creation === 'project' ? '新建项目' : '新建文档'}
            </DialogTitle>
            <DialogDescription>
              {creation === 'project'
                ? '用一个清晰的名称，归拢相关的文档与决定。'
                : '先给文档起个名字，然后开始编辑正文。'}
            </DialogDescription>
          </DialogHeader>
          {creation && (
            <form
              id="create-content"
              key={creation}
              onSubmit={(event) => {
                void (creation === 'project'
                  ? createProject(event)
                  : createDocument(event));
              }}
            >
              <FieldGroup>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="content-name">
                    {creation === 'project' ? '项目名称' : '文档标题'}
                  </FieldLabel>
                  <Input
                    id="content-name"
                    name={creation === 'project' ? 'name' : 'title'}
                    required
                    maxLength={creation === 'project' ? 100 : 200}
                    autoFocus
                    disabled={busy}
                  />
                </Field>
              </FieldGroup>
            </form>
          )}
          {error && creation && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>创建失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setCreation(null);
                setError('');
              }}
            >
              取消
            </Button>
            <Button type="submit" form="create-content" disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {creation === 'project' ? '创建项目' : '创建文档'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {chatOpen && projectId && (board || documentId) ? (
        <aside
          className="fixed top-20 right-4 bottom-4 z-20 flex w-[min(24rem,calc(100vw-1rem))] min-w-0 flex-col"
          aria-label="AI 对话面板"
        >
          <Card className="min-h-0 flex-1 gap-0 overflow-hidden py-0">
            <TaskConversation
              key={projectId}
              projectId={projectId}
              projectName={
                projects.find((project) => project.id === projectId)?.name ??
                '项目'
              }
              onOpenBoard={openBoard}
              onMinimize={() => setChatOpen(false)}
            />
          </Card>
        </aside>
      ) : null}
      {!chatOpen && projectId && (board || documentId) ? (
        <Button
          className="fixed right-4 bottom-4 z-20"
          onClick={() => {
            setChatOpen(true);
            setOpenMobile(false);
          }}
        >
          <SparklesIcon data-icon="inline-start" />
          AI 对话
        </Button>
      ) : null}
      {confirmationDialog}
    </div>
  );
}

const ideaSentence = /[。！？!?]/;

function projectNameFromIdea(body: string) {
  const line = body.trim().split('\n')[0] ?? '';
  const sentence = line.split(ideaSentence)[0]?.trim() || line.trim();
  return sentence.slice(0, 100);
}

function leavePrompt(pathname: string) {
  if (pathname.endsWith('/board'))
    return {
      title: '打开任务看板？',
      description: '当前未保存的修改将丢失。',
      confirmLabel: '放弃修改并打开',
    };
  if (pathname.includes('/documents/'))
    return {
      title: '切换文档？',
      description: '当前未保存的修改将丢失。',
      confirmLabel: '放弃修改并切换',
    };
  if (pathname.includes('/projects/'))
    return {
      title: '切换项目？',
      description: '当前未保存的修改将丢失。',
      confirmLabel: '放弃修改并切换',
    };
  return {
    title: '离开当前页面？',
    description: '当前未保存的修改将丢失。',
    confirmLabel: '放弃修改并离开',
  };
}
