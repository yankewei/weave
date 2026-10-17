import { useEffect, useState } from 'react';
import {
  userStorageStateSchema,
  type WorkspaceStorage,
} from '@weave/contracts';
import { AlertCircleIcon, CheckIcon } from 'lucide-react';
import { api } from './api.js';
import { StorageFields, type StorageForm } from './StorageFields.js';
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

export function UserStorage({ userName }: { userName: string }) {
  const [saved, setSaved] = useState<WorkspaceStorage | null>(null);
  const [form, setForm] = useState(empty);
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api('/account/storage', userStorageStateSchema, {
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
        setSaved(null);
        setLoadFailed(true);
        setError(
          caught instanceof Error ? caught.message : '存储配置加载失败。',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry]);

  async function save() {
    if (!saved && secret.trim() === '') {
      setError('请填写访问密钥。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const state = await api('/account/storage', userStorageStateSchema, {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          ...(secret.trim() ? { secretAccessKey: secret } : {}),
        }),
      });
      setSaved(state.storage);
      setForm(state.storage ?? form);
      setSecret('');
      setNotice(`已保存${userName}的个人存储。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '存储配置保存失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{userName}的个人存储</CardTitle>
        <CardDescription>
          服务地址、区域、桶、目录和访问密钥。访问密钥只留在服务端，保存后不再显示。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="text-muted-foreground">正在加载个人存储…</p>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : loadFailed ? null : (
          <form
            id="account-storage"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <StorageFields
              idPrefix="account-storage"
              form={form}
              secret={secret}
              secretRequired={!saved}
              secretDescription={
                saved
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
        )}
        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>个人存储失败</AlertTitle>
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
        <CardFooter className="justify-end">
          <Button type="submit" form="account-storage" disabled={busy}>
            {busy && <Spinner data-icon="inline-start" />}
            保存{userName}的个人存储
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
