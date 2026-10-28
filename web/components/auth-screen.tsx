import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { userSchema } from '@/lib/contracts';
import {
  AlertCircleIcon,
  CheckCheckIcon,
  LayersIcon,
  MessageSquareIcon,
  SparklesIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
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
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';

export function AuthScreen() {
  const navigate = useNavigate();
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
      await api(register ? '/auth/register' : '/auth/login', userSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      void navigate('/', { replace: true });
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
