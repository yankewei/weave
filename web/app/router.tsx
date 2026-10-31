import { lazy, Suspense } from 'react';
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Link,
  Outlet,
  redirect,
  useLoaderData,
  useParams,
  useRouteError,
  type LoaderFunctionArgs,
} from 'react-router';
import { z } from 'zod';
import { AlertCircleIcon, SearchXIcon } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { userSchema, workspaceSchema } from '@/lib/contracts';
import { AppShell } from '@/components/app-shell';
import type { WorkspaceViewKind } from '@/components/workspace-view';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { TooltipProvider } from '@/components/ui/tooltip';

// Keep the editor and board dependencies (Tiptap, dnd-kit) out of the shell bundle.
const AuthScreen = lazy(() =>
  import('@/components/auth-screen').then((module) => ({
    default: module.AuthScreen,
  })),
);
const WorkspaceView = lazy(() =>
  import('@/components/workspace-view').then((module) => ({
    default: module.WorkspaceView,
  })),
);

// Loaders take over the guards the server-rendered pages used to run.

async function currentUser(signal: AbortSignal) {
  try {
    return await api('/auth/session', userSchema, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

async function requireUser(signal: AbortSignal) {
  const user = await currentUser(signal);
  if (!user) throw redirect('/login');
  return user;
}

function listWorkspaces(signal: AbortSignal) {
  return api('/workspaces', workspaceSchema.array(), { signal });
}

async function homeLoader({ request }: LoaderFunctionArgs) {
  await requireUser(request.signal);
  const first = (await listWorkspaces(request.signal))[0];
  if (first) throw redirect(`/workspaces/${first.id}`);
  return null;
}

async function loginLoader({ request }: LoaderFunctionArgs) {
  if (await currentUser(request.signal)) throw redirect('/');
  return null;
}

async function workspaceLoader({ params, request }: LoaderFunctionArgs) {
  const user = await requireUser(request.signal);
  const workspaces = await listWorkspaces(request.signal);
  if (!workspaces.some((workspace) => workspace.id === params.workspaceId))
    throw redirect('/');
  return { user, workspaces };
}

async function browseLoader({ params, request }: LoaderFunctionArgs) {
  try {
    const { path } = await api(
      `/workspaces/${params.workspaceId}/browse/${encodeURIComponent(params.key ?? '')}`,
      z.object({ path: z.string() }),
      { signal: request.signal },
    );
    throw redirect(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function Root() {
  return (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
  );
}

function Loading() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <Spinner />
    </div>
  );
}

function RouteError() {
  const error = useRouteError();
  const message =
    error instanceof Error
      ? error.message
      : isRouteErrorResponse(error)
        ? error.statusText
        : '请刷新页面重试。';
  return (
    <Empty className="min-h-svh">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlertCircleIcon />
        </EmptyMedia>
        <EmptyTitle>页面加载失败</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          onClick={() => {
            window.location.reload();
          }}
        >
          重新加载
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function NotFound() {
  return (
    <Empty className="min-h-svh">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>页面不存在</EmptyTitle>
        <EmptyDescription>
          地址可能写错了，或者页面已经被删除。
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button nativeButton={false} render={<Link to="/" />}>
          回到首页
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function NoWorkspace() {
  return (
    <main className="p-8 text-sm text-muted-foreground">
      你暂时没有可访问的工作空间。
    </main>
  );
}

function WorkspaceLayout() {
  const { user, workspaces } = useLoaderData<typeof workspaceLoader>();
  const { workspaceId = '' } = useParams();
  return (
    <AppShell user={user} workspaces={workspaces} workspaceId={workspaceId}>
      <Outlet />
    </AppShell>
  );
}

function WorkspacePage({ view }: { view: WorkspaceViewKind }) {
  const { workspaceId = '', projectId = '', documentId = '' } = useParams();
  return (
    <Suspense fallback={<Loading />}>
      <WorkspaceView
        workspaceId={workspaceId}
        projectId={projectId}
        documentId={documentId}
        view={view}
      />
    </Suspense>
  );
}

function BrowseMissing() {
  const { key = '' } = useParams();
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>找不到 {key.toUpperCase()}</EmptyTitle>
        <EmptyDescription>
          这个编号在当前工作空间里没有对应的任务或文档。
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export const router = createBrowserRouter([
  {
    Component: Root,
    HydrateFallback: Loading,
    ErrorBoundary: RouteError,
    children: [
      { path: '/', loader: homeLoader, Component: NoWorkspace },
      {
        path: '/login',
        loader: loginLoader,
        element: (
          <Suspense fallback={<Loading />}>
            <AuthScreen />
          </Suspense>
        ),
      },
      {
        path: '/workspaces/:workspaceId',
        loader: workspaceLoader,
        // Like a server layout, refetch the shell only when the workspace changes.
        shouldRevalidate: ({ currentParams, nextParams }) =>
          currentParams.workspaceId !== nextParams.workspaceId,
        Component: WorkspaceLayout,
        children: [
          {
            index: true,
            element: <WorkspacePage view="conversation" />,
          },
          { path: 'settings', element: <WorkspacePage view="settings" /> },
          {
            path: 'projects/:projectId',
            element: <WorkspacePage view="conversation" />,
          },
          {
            path: 'projects/:projectId/board',
            element: <WorkspacePage view="board" />,
          },
          {
            path: 'projects/:projectId/documents/:documentId',
            element: <WorkspacePage view="document" />,
          },
          {
            path: 'browse/:key',
            loader: browseLoader,
            Component: BrowseMissing,
          },
        ],
      },
      { path: '*', Component: NotFound },
    ],
  },
]);
