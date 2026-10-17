import { useEffect, useState, type FormEvent } from 'react';
import {
  membershipChangeSchema,
  workspaceMemberSchema,
  type MembershipChange,
  type User,
  type WorkspaceMember,
} from '@weave/contracts';
import { AlertCircleIcon, CheckIcon, UsersIcon } from 'lucide-react';
import { api } from './api.js';
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

function roleLabel(role: WorkspaceMember['role']) {
  return role === 'admin' ? '管理员' : '成员';
}

function removalNotice(name: string, change: MembershipChange) {
  const parts = [`已移除${name}`];
  if (change.unassignedTaskCount > 0)
    parts.push(`${change.unassignedTaskCount} 项任务已改为未分配`);
  if (change.rejectedProposalCount > 0)
    parts.push(`${change.rejectedProposalCount} 份待确认提案已拒绝`);
  return `${parts.join('，')}。`;
}

export function WorkspaceMembers({
  workspaceId,
  workspaceName,
  user,
  onLeft,
  onRoleChange,
}: {
  workspaceId: string;
  workspaceName: string;
  user: User;
  onLeft: () => Promise<void>;
  onRoleChange?: (role: WorkspaceMember['role'] | null) => void;
}) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [invalidEmail, setInvalidEmail] = useState(false);
  const [notice, setNotice] = useState('');
  const { confirm, confirmationDialog } = useConfirmation();
  const busy = pendingId !== null;
  const viewer = members.find((member) => member.id === user.id);
  const adminCount = members.filter((member) => member.role === 'admin').length;
  const viewerRole = viewer?.role ?? null;

  useEffect(() => {
    onRoleChange?.(viewerRole);
  }, [onRoleChange, viewerRole]);

  useEffect(() => {
    const controller = new AbortController();
    api(`/workspaces/${workspaceId}/members`, workspaceMemberSchema.array(), {
      signal: controller.signal,
    })
      .then((rows) => {
        if (!controller.signal.aborted) setMembers(rows);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : '成员加载失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry, workspaceId]);

  async function load() {
    setError('');
    try {
      setMembers(
        await api(
          `/workspaces/${workspaceId}/members`,
          workspaceMemberSchema.array(),
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '成员加载失败。');
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get('email'));
    setPendingId('invite');
    setError('');
    setNotice('');
    setInvalidEmail(false);
    try {
      const member = await api(
        `/workspaces/${workspaceId}/members`,
        workspaceMemberSchema,
        { method: 'POST', body: JSON.stringify({ email }) },
      );
      form.reset();
      setNotice(`已邀请${member.name}。`);
      await load();
    } catch (caught) {
      setInvalidEmail(true);
      setError(caught instanceof Error ? caught.message : '邀请失败。');
    } finally {
      setPendingId(null);
    }
  }

  async function remove(member: WorkspaceMember) {
    const self = member.id === user.id;
    const accepted = await confirm({
      title: self ? '退出工作空间？' : `移除${member.name}？`,
      description: self
        ? '退出会关闭当前页面，未保存的修改将丢失。你负责的任务会改为未分配，你尚未处理的提案会被拒绝。'
        : `${member.name}负责的任务会改为未分配，此人尚未处理的提案会被拒绝。你仍留在这个页面。`,
      confirmLabel: self ? '退出工作空间' : '移除',
    });
    if (!accepted) return;
    setPendingId(member.id);
    setError('');
    setNotice('');
    try {
      const change = await api(
        `/workspaces/${workspaceId}/members/${member.id}`,
        membershipChangeSchema,
        { method: 'DELETE' },
      );
      if (self) {
        await onLeft();
        return;
      }
      setNotice(removalNotice(member.name, change));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '移除失败。');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{workspaceName}的成员</CardTitle>
        <CardDescription>
          工作空间的成员可以查看和编辑这里的项目。管理员可以邀请已经注册的账号，邀请后成为成员。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {viewer?.role === 'admin' && (
          <form onSubmit={(event) => void invite(event)}>
            <FieldGroup>
              <Field
                data-disabled={busy}
                {...(invalidEmail ? { 'data-invalid': true } : {})}
              >
                <FieldLabel htmlFor="member-email">邮箱</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="member-email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    autoFocus
                    disabled={busy}
                    aria-invalid={invalidEmail}
                    className="min-w-0 flex-1"
                  />
                  <Button type="submit" disabled={busy || loading}>
                    {pendingId === 'invite' && (
                      <Spinner data-icon="inline-start" />
                    )}
                    邀请
                  </Button>
                </div>
                <FieldDescription>
                  对方需要已经有 Weave 账号。邀请后成为成员。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>成员操作失败</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setLoading(true);
                  setError('');
                  setRetry((value) => value + 1);
                }}
              >
                重试
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert role="status">
            <CheckIcon />
            <AlertTitle>{notice}</AlertTitle>
          </Alert>
        )}
        {loading ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-muted-foreground">正在加载成员…</p>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : !error && members.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>还没有成员</EmptyTitle>
              <EmptyDescription>
                邀请已经注册的账号后，对方会出现在这里。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="工作空间成员">
            {members.map((member) => {
              const self = member.id === user.id;
              const soleAdmin = member.role === 'admin' && adminCount < 2;
              return (
                <li
                  key={member.id}
                  className="flex flex-wrap items-center gap-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{member.name}</span>
                    <span className="truncate text-muted-foreground">
                      {member.email}
                    </span>
                  </div>
                  <Badge
                    variant={member.role === 'admin' ? 'secondary' : 'outline'}
                  >
                    {roleLabel(member.role)}
                  </Badge>
                  {self && soleAdmin ? (
                    <p className="text-muted-foreground">
                      你是唯一的管理员，不能退出。
                    </p>
                  ) : self || viewer?.role === 'admin' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void remove(member);
                      }}
                    >
                      {pendingId === member.id && (
                        <Spinner data-icon="inline-start" />
                      )}
                      {self ? '退出工作空间' : '移除'}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      {confirmationDialog}
    </Card>
  );
}
