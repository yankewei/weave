'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { User, Workspace } from '@/lib/contracts';
import {
  AlertCircleIcon,
  LayersIcon,
  LogOutIcon,
  SettingsIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { CurrentUserContext, LeaveWorkspaceContext } from '@/lib/current-user';
import { WorkspaceListContext } from '@/lib/workspace-list';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { useConfirmation } from '@/hooks/use-confirmation';

export function AppShell({
  user,
  workspaces,
  workspaceId,
  children,
}: {
  user: User;
  workspaces: Workspace[];
  workspaceId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { confirm, confirmationDialog } = useConfirmation();

  async function logout() {
    if (
      !(await confirm({
        title: '退出登录？',
        description: '退出会关闭当前文档，未保存的内容将丢失。',
        confirmLabel: '退出登录',
      }))
    )
      return;
    setBusy(true);
    try {
      await api('/auth/logout', { parse: () => null }, { method: 'POST' });
      router.replace('/login');
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : '退出失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function switchWorkspace(id: string) {
    if (!id || id === workspaceId) return;
    if (
      !(await confirm({
        title: '切换工作空间？',
        description: '切换会关闭当前文档，未保存的内容将丢失。',
        confirmLabel: '切换工作空间',
      }))
    )
      return;
    router.push(`/workspaces/${id}`);
  }

  async function leftWorkspace() {
    router.replace('/');
    router.refresh();
  }

  return (
    <CurrentUserContext.Provider value={user}>
      <WorkspaceListContext.Provider value={workspaces}>
        <LeaveWorkspaceContext.Provider value={leftWorkspace}>
          <SidebarProvider className="flex-col">
            <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
              <SidebarTrigger aria-label="切换项目导航" />
              <Link href="/" className="flex items-center gap-2 font-medium">
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
                  value={workspaceId}
                  onChange={(event) => {
                    void switchWorkspace(event.target.value);
                  }}
                  disabled={busy}
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
                  disabled={busy}
                  onClick={() => {
                    router.push(`/workspaces/${workspaceId}/settings`);
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
                  </AlertDescription>
                </Alert>
              </div>
            )}
            {children}
            {confirmationDialog}
          </SidebarProvider>
        </LeaveWorkspaceContext.Provider>
      </WorkspaceListContext.Provider>
    </CurrentUserContext.Provider>
  );
}
