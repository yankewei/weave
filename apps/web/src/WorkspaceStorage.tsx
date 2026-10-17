import { useEffect, useState } from 'react';
import {
  workspaceStorageStateSchema,
  type StorageShortcut,
  type WorkspaceStorage,
} from '@weave/contracts';
import { AlertCircleIcon, CheckIcon } from 'lucide-react';
import { api } from './api.js';
import { StorageFields, type StorageForm } from './StorageFields.js';
import { useConfirmation } from '@/hooks/use-confirmation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';

const empty: StorageForm = {
  endpoint: '',
  region: '',
  bucket: '',
  prefix: '',
  accessKeyId: '',
};

export function WorkspaceStorage({
  workspaceId,
  workspaceName,
  userId,
  userName,
}: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userName: string;
}) {
  const { confirm, confirmationDialog } = useConfirmation();
  const [saved, setSaved] = useState<WorkspaceStorage | null>(null);
  const [shortcut, setShortcut] = useState<StorageShortcut | null>(null);
  const [form, setForm] = useState(empty);
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState<'save' | 'shortcut' | 'clear' | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = pending !== null;
  const ownsSecret = Boolean(saved) && !shortcut;

  function apply(state: {
    storage: WorkspaceStorage | null;
    shortcut: StorageShortcut | null;
  }) {
    setSaved(state.storage);
    setShortcut(state.shortcut);
    setForm(state.shortcut ? empty : (state.storage ?? empty));
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
        setShortcut(state.shortcut);
        setForm(state.shortcut ? empty : (state.storage ?? empty));
        setSecret('');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setSaved(null);
        setShortcut(null);
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
    if (!ownsSecret && secret.trim() === '') {
      setError('请填写访问密钥。');
      return;
    }
    setPending('save');
    setError('');
    setNotice('');
    try {
      apply(
        await api(
          `/workspaces/${workspaceId}/storage`,
          workspaceStorageStateSchema,
          {
            method: 'PUT',
            body: JSON.stringify({
              ...form,
              ...(secret.trim() ? { secretAccessKey: secret } : {}),
            }),
          },
        ),
      );
      setNotice(`已保存${workspaceName}的存储。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '存储配置保存失败。');
    } finally {
      setPending(null);
    }
  }

  async function linkMine() {
    if (ownsSecret) {
      const accepted = await confirm({
        title: `让${workspaceName}改用${userName}的个人存储？`,
        description: `${workspaceName}单独保存的访问密钥会被去掉，之后跟随${userName}的个人存储。`,
        confirmLabel: `让${workspaceName}使用${userName}的个人存储`,
      });
      if (!accepted) return;
    }
    setPending('shortcut');
    setError('');
    setNotice('');
    try {
      apply(
        await api(
          `/workspaces/${workspaceId}/storage/shortcut`,
          workspaceStorageStateSchema,
          { method: 'PUT' },
        ),
      );
      setNotice(`已让${workspaceName}使用${userName}的个人存储。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '存储配置保存失败。');
    } finally {
      setPending(null);
    }
  }

  async function clearShortcut() {
    const name = shortcut?.name ?? '该管理员';
    setPending('clear');
    setError('');
    setNotice('');
    try {
      apply(
        await api(
          `/workspaces/${workspaceId}/storage/shortcut`,
          workspaceStorageStateSchema,
          { method: 'DELETE' },
        ),
      );
      setNotice(`${workspaceName}已取消使用${name}的个人存储。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '存储配置保存失败。');
    } finally {
      setPending(null);
    }
  }

  const usingMine = shortcut?.userId === userId && Boolean(saved);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{workspaceName}的存储</CardTitle>
        <CardDescription>
          可以保存自己的一份，也可以改用一位管理员的个人存储。访问密钥只留在服务端。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-muted-foreground">正在加载存储配置…</p>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : loadFailed ? null : (
          <>
            {shortcut && (
              <div className="flex flex-col gap-1">
                <p>
                  {saved
                    ? `${workspaceName}正在使用${shortcut.name}的个人存储。`
                    : `${shortcut.name}的个人存储现在不可用。${workspaceName}读不到存储位置。`}
                </p>
                {saved && (
                  <p className="text-muted-foreground">
                    {saved.endpoint} · {saved.region} · {saved.bucket}
                    {saved.prefix ? ` · ${saved.prefix}` : ''}
                  </p>
                )}
                <p className="text-muted-foreground">
                  {`在下面保存后，${workspaceName}改用自己填写的存储。`}
                </p>
              </div>
            )}
            <form
              id="workspace-storage"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <StorageFields
                idPrefix="workspace-storage"
                form={form}
                secret={secret}
                secretRequired={!ownsSecret}
                secretDescription={
                  ownsSecret
                    ? '已保存访问密钥。留空则保持不变。'
                    : '密钥保存后不会再显示。'
                }
                busy={busy}
                onChange={(key, value) =>
                  setForm((current) => ({ ...current, [key]: value }))
                }
                onSecret={setSecret}
              />
            </form>
          </>
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
                  disabled={busy}
                  onClick={() => {
                    setLoading(true);
                    setError('');
                    setLoadFailed(false);
                    setNotice('');
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
          {shortcut && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void clearShortcut();
              }}
            >
              {pending === 'clear' && <Spinner data-icon="inline-start" />}
              取消使用{shortcut.name}的个人存储
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy || usingMine}
            onClick={() => {
              void linkMine();
            }}
          >
            {pending === 'shortcut' && <Spinner data-icon="inline-start" />}
            {usingMine
              ? `${workspaceName}正在使用${userName}的个人存储`
              : `让${workspaceName}使用${userName}的个人存储`}
          </Button>
          <Button type="submit" form="workspace-storage" disabled={busy}>
            {pending === 'save' && <Spinner data-icon="inline-start" />}
            保存{workspaceName}的存储
          </Button>
        </CardFooter>
      )}
      {confirmationDialog}
    </Card>
  );
}
