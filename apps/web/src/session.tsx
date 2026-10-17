import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import {
  userSchema,
  workspaceSchema,
  type User,
  type Workspace,
} from '@weave/contracts';
import {
  AlertCircleIcon,
  CheckCheckIcon,
  MessageSquareIcon,
  LayersIcon,
  LogOutIcon,
  SettingsIcon,
  SparklesIcon,
} from 'lucide-react';
import { api, ApiError } from './api.js';
import {
  CurrentUserContext,
  LeaveWorkspaceContext,
  useCurrentUser,
} from './current-user.js';
import { allowNextLeave } from './leave.js';
import { WorkspaceListContext, useWorkspaces } from './workspace-list.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmation } from '@/hooks/use-confirmation';

const WorkspacePage = lazy(() =>
  import('./WorkspacePage.js').then((module) => ({
    default: module.WorkspacePage,
  })),
);

export function NotFoundPage() {
  return <p className="p-8 text-sm text-muted-foreground">这个页面不存在。</p>;
}

export function RootLayout() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api('/auth/session', userSchema, { signal: controller.signal })
      .then(setUser)
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          !(error instanceof ApiError && error.status === 401)
        )
          setError('无法连接服务，请检查接口和数据库后重试。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    const expired = () => {
      setUser(null);
      setError('登录已过期，请重新登录。');
    };
    window.addEventListener('weave:session-expired', expired);
    return () => {
      controller.abort();
      window.removeEventListener('weave:session-expired', expired);
    };
  }, [retry]);
  if (checking)
    return (
      <main
        className="flex min-h-svh flex-col items-center justify-center gap-6 p-6"
        role="status"
      >
        <Spinner />
        <p className="text-sm text-muted-foreground">正在打开工作空间…</p>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </main>
    );
  if (!user)
    return (
      <AuthScreen
        error={error}
        onRetry={() => {
          setChecking(true);
          setError('');
          setRetry(retry + 1);
        }}
        onAuthenticated={(user) => {
          setError('');
          setUser(user);
        }}
      />
    );
  return (
    <CurrentUserContext.Provider value={user}>
      <WorkspaceShell onLogout={() => setUser(null)} />
    </CurrentUserContext.Provider>
  );
}

export function WorkspaceIndex() {
  const workspaces = useWorkspaces();
  const navigate = useNavigate();
  useEffect(() => {
    const first = workspaces[0];
    if (!first) return;
    void navigate({
      to: '/workspaces/$workspaceId',
      params: { workspaceId: first.id },
      replace: true,
    });
  }, [navigate, workspaces]);
  if (workspaces.length === 0)
    return (
      <p className="p-8 text-sm text-muted-foreground">
        你暂时没有可访问的工作空间。
      </p>
    );
  return (
    <div className="flex items-center gap-2 p-8" role="status">
      <Spinner />
      正在打开工作空间…
    </div>
  );
}

export function WorkspaceRoute() {
  const params = useParams({ strict: false, shouldThrow: false });
  const workspaceId = params?.workspaceId ?? '';
  const user = useCurrentUser();
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 p-8" role="status">
          <Spinner />
          正在加载文档工作区…
        </div>
      }
    >
      <WorkspacePage key={workspaceId} currentUserId={user.id} />
    </Suspense>
  );
}

function AuthScreen({
  error: initialError,
  onAuthenticated,
  onRetry,
}: {
  error: string;
  onAuthenticated: (user: User) => void;
  onRetry: () => void;
}) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const input = {
        email: String(data.get('email')),
        password: String(data.get('password')),
        ...(register
          ? {
              name: String(data.get('name')),
              workspaceName: String(data.get('workspaceName')),
            }
          : {}),
      };
      onAuthenticated(
        await api(register ? '/auth/register' : '/auth/login', userSchema, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '登录失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <aside className="flex flex-col justify-between gap-12 bg-muted/50 p-8 lg:p-14">
        <Link
          className="flex w-fit items-center gap-3 font-medium"
          to="/"
          aria-label="Weave 首页"
        >
          <LayersIcon className="size-6" />
          Weave
        </Link>
        <div className="flex max-w-lg flex-col gap-8">
          <Badge variant="outline">AI 驱动的项目协作</Badge>
          <h1 className="text-3xl leading-tight font-medium tracking-tight lg:text-4xl">
            与 AI 一起，
            <br />
            把想法推进成项目。
          </h1>
          <p className="max-w-sm text-sm leading-7 text-muted-foreground">
            描述你的想法，与 AI 澄清需求、形成文档、拆分任务。AI
            先提出变更提案，由你确认后写入正式内容。
          </p>
          <p className="text-xs leading-6 text-muted-foreground">
            在项目里描述要做的事，AI
            会提出任务提案。确认后任务才写入看板。文档修改提案仍未接入。
          </p>
          <Separator />
          <div className="flex flex-col gap-5 text-sm text-muted-foreground">
            <p className="flex items-center gap-3">
              <MessageSquareIcon className="size-4" />和 AI
              讨论，让模糊的需求变清晰
            </p>
            <p className="flex items-center gap-3">
              <SparklesIcon className="size-4" />由 AI 生成文档与任务提案
            </p>
            <p className="flex items-center gap-3">
              <CheckCheckIcon className="size-4" />
              你确认后生效，每次修改都能追溯
            </p>
          </div>
        </div>
        <p className="hidden text-xs text-muted-foreground lg:block">
          AI 提出建议，你决定哪些成为正式内容。
        </p>
      </aside>
      <main className="flex items-center justify-center p-6 sm:p-12">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>
              <h2>{register ? '创建账号' : '欢迎回来'}</h2>
            </CardTitle>
            <CardDescription>
              {register
                ? '注册后会为你创建一个工作空间。'
                : '登录，进入你的 AI 项目工作空间。'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {initialError && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>连接需要检查</AlertTitle>
                <AlertDescription>
                  <p>{initialError}</p>
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    重新连接
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>
                  {register ? '创建账号失败' : '登录失败'}
                </AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <form
              id="auth-form"
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              <FieldGroup>
                {register && (
                  <>
                    <Field data-disabled={busy}>
                      <FieldLabel htmlFor="auth-name">你的名字</FieldLabel>
                      <Input
                        id="auth-name"
                        name="name"
                        required
                        maxLength={80}
                        autoComplete="name"
                        disabled={busy}
                      />
                    </Field>
                    <Field data-disabled={busy}>
                      <FieldLabel htmlFor="workspace-name">
                        工作空间名称
                      </FieldLabel>
                      <Input
                        id="workspace-name"
                        name="workspaceName"
                        required
                        maxLength={100}
                        placeholder="例如：产品团队"
                        disabled={busy}
                      />
                    </Field>
                  </>
                )}
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="auth-email">邮箱</FieldLabel>
                  <Input
                    id="auth-email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    placeholder="name@example.com"
                    disabled={busy}
                  />
                </Field>
                <Field data-disabled={busy}>
                  <FieldLabel htmlFor="auth-password">密码</FieldLabel>
                  <Input
                    id="auth-password"
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete={
                      register ? 'new-password' : 'current-password'
                    }
                    disabled={busy}
                  />
                  <FieldDescription>密码至少 12 个字符。</FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
          <CardFooter className="flex-col gap-2">
            <Button
              className="w-full"
              type="submit"
              form="auth-form"
              disabled={busy}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {busy ? '请稍候…' : register ? '创建账号与工作空间' : '登录'}
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              disabled={busy}
              onClick={() => {
                setRegister(!register);
                setError('');
              }}
            >
              {register ? '已有账号？登录' : '第一次使用？创建账号'}
            </Button>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}

function WorkspaceShell({ onLogout }: { onLogout: () => void }) {
  const user = useCurrentUser();
  const params = useParams({ strict: false, shouldThrow: false });
  const routeWorkspaceId = params?.workspaceId ?? '';
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const { confirm, confirmationDialog } = useConfirmation();
  const selectedWorkspaceId =
    workspaces.find((workspace) => workspace.id === routeWorkspaceId)?.id ??
    workspaces[0]?.id ??
    '';
  useEffect(() => {
    const controller = new AbortController();
    api('/workspaces', workspaceSchema.array(), { signal: controller.signal })
      .then(setWorkspaces)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '加载失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry]);
  async function logout() {
    if (
      !(await confirm({
        title: '退出登录？',
        description: '退出会关闭当前文档，未保存的内容将丢失。',
        confirmLabel: '退出登录',
      }))
    )
      return;
    try {
      await api('/auth/logout', { parse: () => null }, { method: 'POST' });
      onLogout();
    } catch (error) {
      setError(error instanceof Error ? error.message : '退出失败，请重试。');
    }
  }
  async function leftWorkspace() {
    const leftId = selectedWorkspaceId;
    setWorkspaces((current) =>
      current.filter((workspace) => workspace.id !== leftId),
    );
    allowNextLeave.current = true;
    try {
      await navigate({ to: '/' });
    } finally {
      allowNextLeave.current = false;
    }
    try {
      setWorkspaces(await api('/workspaces', workspaceSchema.array()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '工作空间加载失败。');
    }
  }
  async function switchWorkspace(id: string) {
    if (!id || id === routeWorkspaceId) return;
    if (
      !(await confirm({
        title: '切换工作空间？',
        description: '切换会关闭当前文档，未保存的内容将丢失。',
        confirmLabel: '切换工作空间',
      }))
    )
      return;
    allowNextLeave.current = true;
    try {
      await navigate({
        to: '/workspaces/$workspaceId',
        params: { workspaceId: id },
      });
    } finally {
      allowNextLeave.current = false;
    }
  }
  return (
    <WorkspaceListContext.Provider value={workspaces}>
      <LeaveWorkspaceContext.Provider value={leftWorkspace}>
        <SidebarProvider className="flex-col">
          <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
            <SidebarTrigger aria-label="切换项目导航" />
            <Link to="/" className="flex items-center gap-2 font-medium">
              <LayersIcon className="size-5" />
              <span className="hidden sm:inline">Weave</span>
            </Link>
            <Separator orientation="vertical" className="mx-1 h-5" />
            <Field className="w-auto min-w-0">
              <FieldLabel className="sr-only" htmlFor="workspace">
                工作空间
              </FieldLabel>
              <NativeSelect
                id="workspace"
                className="max-w-48 sm:max-w-64"
                value={selectedWorkspaceId}
                onChange={(event) => {
                  void switchWorkspace(event.target.value);
                }}
                disabled={loading}
              >
                {workspaces.map((workspace) => (
                  <NativeSelectOption key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {user.name}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={loading || !selectedWorkspaceId}
                onClick={() => {
                  if (!selectedWorkspaceId) return;
                  void navigate({
                    to: '/workspaces/$workspaceId/settings',
                    params: { workspaceId: selectedWorkspaceId },
                  });
                }}
              >
                <SettingsIcon data-icon="inline-start" />
                设置
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void logout();
                }}
              >
                <LogOutIcon data-icon="inline-start" />
                退出登录
              </Button>
            </div>
          </header>
          {error && (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>工作空间加载失败</AlertTitle>
                <AlertDescription>
                  <p>{error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setError('');
                      setLoading(true);
                      setRetry(retry + 1);
                    }}
                  >
                    重试
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          )}
          {loading ? (
            <div className="flex flex-1 flex-col gap-5 p-8" role="status">
              <p className="text-sm text-muted-foreground">正在加载工作空间…</p>
              <Skeleton className="h-8 w-60" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : error ? null : (
            <Outlet />
          )}
          {confirmationDialog}
        </SidebarProvider>
      </LeaveWorkspaceContext.Provider>
    </WorkspaceListContext.Provider>
  );
}
