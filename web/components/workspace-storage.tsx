import { useEffect, useState } from 'react';
import {
  workspaceStorageStateSchema,
  type WorkspaceStorage as Storage,
} from '@/lib/contracts';
import { AlertCircleIcon, CheckIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useConfirmation } from '@/hooks/use-confirmation';
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

const empty: Storage = {
  endpoint: '',
  region: '',
  bucket: '',
  prefix: '',
  accessKeyId: '',
};

const fields = [
  {
    key: 'endpoint',
    label: '服务地址',
    maxLength: 300,
    required: true,
    placeholder: 'https://账户编号.r2.cloudflarestorage.com',
  },
  {
    key: 'region',
    label: '区域',
    maxLength: 64,
    required: true,
    placeholder: 'auto',
    description: 'Cloudflare R2 填 auto。',
  },
  { key: 'bucket', label: '桶', maxLength: 63, required: true },
  {
    key: 'prefix',
    label: '目录',
    maxLength: 200,
    required: false,
    placeholder: 'images',
    description: '可以留空。图片会放在这个目录下。',
  },
  { key: 'accessKeyId', label: '访问密钥编号', maxLength: 128, required: true },
] as const;

export function WorkspaceStorage({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const { confirm, confirmationDialog } = useConfirmation();
  const [saved, setSaved] = useState<Storage | null>(null);
  const [form, setForm] = useState(empty);
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<'save' | 'clear' | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = pending !== null;

  function apply(storage: Storage | null) {
    setSaved(storage);
    setForm(storage ?? empty);
    setSecret('');
  }

  useEffect(() => {
    const controller = new AbortController();
    api(`/workspaces/${workspaceId}/storage`, workspaceStorageStateSchema, {
      signal: controller.signal,
    })
      .then((state) => {
        if (controller.signal.aborted) return;
        setSaved(state.storage);
        setForm(state.storage ?? empty);
        setSecret('');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
        setError(
          caught instanceof Error ? caught.message : '存储配置加载失败。',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry, workspaceId]);

  async function save() {
    if (!saved && secret.trim() === '') {
      setError('请填写访问密钥。');
      return;
    }
    setPending('save');
    setError('');
    setNotice('');
    try {
      const state = await api(
        `/workspaces/${workspaceId}/storage`,
        workspaceStorageStateSchema,
        {
          method: 'PUT',
          body: JSON.stringify({
            ...form,
            ...(secret.trim() ? { secretAccessKey: secret } : {}),
          }),
        },
      );
      apply(state.storage);
      setNotice(`${workspaceName}之后上传的图片会存到这个 S3。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '存储配置保存失败。');
    } finally {
      setPending(null);
    }
  }

  async function clear() {
    const accepted = await confirm({
      title: `让${workspaceName}改回默认存储？`,
      description:
        '之后上传的图片存到 Vercel Blob。已经存在这个 S3 里的图片将无法显示，访问密钥会从服务端删除。',
      confirmLabel: '改回默认存储',
    });
    if (!accepted) return;
    setPending('clear');
    setError('');
    setNotice('');
    try {
      const state = await api(
        `/workspaces/${workspaceId}/storage`,
        workspaceStorageStateSchema,
        { method: 'DELETE' },
      );
      apply(state.storage);
      setNotice(`${workspaceName}已改回默认存储。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '存储配置保存失败。');
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{workspaceName}的存储</CardTitle>
        <CardDescription>
          图片默认存到 Vercel Blob。填写 S3
          兼容存储后，之后上传的图片改存到这里。图片只有成员可以看到，访问密钥只留在服务端。
        </CardDescription>
        {!loading && !loadFailed && (
          <CardAction>
            <Badge variant={saved ? 'default' : 'secondary'}>
              {saved ? '自定义 S3' : 'Vercel Blob'}
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-muted-foreground">正在加载存储配置…</p>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : loadFailed ? null : (
          <form
            id="workspace-storage"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FieldGroup>
              {fields.map((field) => (
                <Field key={field.key} data-disabled={busy}>
                  <FieldLabel htmlFor={`workspace-storage-${field.key}`}>
                    {field.label}
                  </FieldLabel>
                  <Input
                    id={`workspace-storage-${field.key}`}
                    value={form[field.key]}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                    required={field.required}
                    maxLength={field.maxLength}
                    autoComplete="off"
                    disabled={busy}
                    placeholder={
                      'placeholder' in field ? field.placeholder : undefined
                    }
                  />
                  {'description' in field && (
                    <FieldDescription>{field.description}</FieldDescription>
                  )}
                </Field>
              ))}
              <Field data-disabled={busy}>
                <FieldLabel htmlFor="workspace-storage-secret">
                  访问密钥
                </FieldLabel>
                <Input
                  id="workspace-storage-secret"
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  maxLength={256}
                  autoComplete="new-password"
                  required={!saved}
                  disabled={busy}
                />
                <FieldDescription>
                  {saved
                    ? '已保存访问密钥。留空则保持不变。'
                    : '密钥保存后不会再显示。'}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>存储配置失败</AlertTitle>
            <AlertDescription>
              <p>{error}</p>
              {loadFailed && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLoading(true);
                    setError('');
                    setLoadFailed(false);
                    setRetry((value) => value + 1);
                  }}
                >
                  重试
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert role="status">
            <CheckIcon />
            <AlertTitle>{notice}</AlertTitle>
          </Alert>
        )}
      </CardContent>
      {!loading && !loadFailed && (
        <CardFooter className="flex-wrap justify-end gap-2">
          {saved && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void clear();
              }}
            >
              {pending === 'clear' && <Spinner data-icon="inline-start" />}
              改回默认存储
            </Button>
          )}
          <Button type="submit" form="workspace-storage" disabled={busy}>
            {pending === 'save' && <Spinner data-icon="inline-start" />}
            保存 S3 存储
          </Button>
        </CardFooter>
      )}
      {confirmationDialog}
    </Card>
  );
}
