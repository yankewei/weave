'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { diffLines } from 'diff';
import {
  documentSchema,
  imageUploadMaxBytes,
  revisionSchema,
  uploadSchema,
  type Document,
} from '@/lib/contracts';
import { api, ApiError } from '@/lib/api';
import { documentKey } from '@/lib/references';
import {
  AlertCircleIcon,
  CheckIcon,
  FileTextIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
  SaveIcon,
} from 'lucide-react';
import {
  DocumentContent,
  RichTextEditor,
  type InsertImage,
} from '@/components/rich-text-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useConfirmation } from '@/hooks/use-confirmation';
import { cn } from '@/lib/utils';

const kindLabels = {
  create: '创建文档',
  edit: '手工编辑',
  restore: '恢复历史',
};

export function DocumentEditor({
  document,
  navigationBusy = false,
  onSaved,
  onDirtyChange,
  onBusyChange,
}: {
  document: Document;
  navigationBusy?: boolean;
  onSaved: (document: Document) => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [editing, setEditing] = useState(document.body === '');
  const [title, setTitle] = useState(document.title);
  const [body, setBody] = useState(document.body);
  // The editor rewrites Markdown into its own canonical form on load; only edits after that count.
  const [baseline, setBaseline] = useState(document.body);
  const [editorKey, setEditorKey] = useState(0);
  const [revisions, setRevisions] = useState<
    ReturnType<typeof revisionSchema.parse>[]
  >([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [retry, setRetry] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const { confirm, confirmationDialog } = useConfirmation();
  const dirty = title !== document.title || body !== baseline;
  const selected =
    revisions.find((revision) => revision.version === selectedVersion) ??
    revisions[0];
  const previous =
    selected &&
    revisions.find((revision) => revision.version === selected.version - 1);

  const changes = useMemo(
    () =>
      selected
        ? diffLines(
            previous ? `${previous.title}\n\n${previous.body}` : '',
            `${selected.title}\n\n${selected.body}`,
            { timeout: 100 },
          )
        : [],
    [previous, selected],
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
    const controller = new AbortController();
    api(`/documents/${document.id}/revisions`, revisionSchema.array(), {
      signal: controller.signal,
    })
      .then((items) => {
        setRevisions(items);
        setHistoryError('');
      })
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
  }, [document.id, document.version, retry]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    try {
      const updated = await api(`/documents/${document.id}`, documentSchema, {
        method: 'PUT',
        body: JSON.stringify({ title, body, baseVersion: document.version }),
      });
      setTitle(updated.title);
      setBody(updated.body);
      setBaseline(updated.body);
      onSaved(updated);
      setSelectedVersion(null);
      setEditing(false);
      setNotice(
        updated.version === document.version
          ? '内容没有变化，无需新增版本。'
          : `已保存为 v${updated.version}`,
      );
      setConflict(false);
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

  // Each image is inserted at the caret as soon as it lands, so a later failure keeps earlier ones.
  async function upload(files: File[], insert: InsertImage) {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    const tooLarge = images.find((file) => file.size > imageUploadMaxBytes);
    if (tooLarge) {
      setUploadError(`${tooLarge.name} 超过 4 MB，没有上传。`);
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      for (const file of images) {
        const form = new FormData();
        form.append('file', file);
        const uploaded = await api(
          `/projects/${document.projectId}/uploads`,
          uploadSchema,
          { method: 'POST', body: form, timeoutMs: 60_000 },
        );
        insert({ src: uploaded.url, alt: uploaded.fileName });
      }
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : '图片上传失败，请重试。',
      );
    } finally {
      setUploading(false);
    }
  }

  async function restore(version: number) {
    if (
      !(await confirm({
        title: `恢复到 v${version} 的内容？`,
        description: `标题与正文会保存为一个新版本，全部历史继续保留。${dirty ? '当前未保存的草稿将丢失。' : ''}`,
        confirmLabel: '确认恢复',
      }))
    )
      return;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    try {
      const updated = await api(
        `/documents/${document.id}/restore`,
        documentSchema,
        {
          method: 'POST',
          body: JSON.stringify({
            baseVersion: document.version,
            revisionVersion: version,
          }),
        },
      );
      replaceDraft(updated);
      setEditing(false);
      setSelectedVersion(null);
      setConflict(false);
      setNotice(
        updated.version === document.version
          ? '历史内容与当前内容一致，未新增版本。'
          : `已从 v${version} 恢复为 v${updated.version}`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '恢复失败。');
      setConflict(error instanceof ApiError && error.status === 409);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  function replaceDraft(updated: Document) {
    setTitle(updated.title);
    setBody(updated.body);
    setBaseline(updated.body);
    setEditorKey((key) => key + 1);
    onSaved(updated);
  }

  async function cancel() {
    if (
      dirty &&
      !(await confirm({
        title: '放弃这次编辑？',
        description: '未保存的标题和正文修改将丢失，文档保持当前版本。',
        confirmLabel: '放弃修改',
      }))
    )
      return;
    replaceDraft(document);
    setError('');
    setConflict(false);
    setEditing(false);
  }

  async function reload() {
    if (
      dirty &&
      !(await confirm({
        title: '放弃草稿并加载最新版本？',
        description: '当前未保存的内容将丢失，请先复制需要保留的草稿。',
        confirmLabel: '放弃草稿并加载',
      }))
    )
      return;
    setBusy(true);
    onBusyChange(true);
    try {
      const updated = await api(`/documents/${document.id}`, documentSchema);
      replaceDraft(updated);
      setError('');
      setConflict(false);
      setNotice('已加载最新版本。');
      setRetry(retry + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : '加载失败。');
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="grid min-w-0 flex-1 xl:grid-cols-[minmax(0,1fr)_21rem]">
      <section className="min-w-0" aria-label="文档编辑">
        <form
          onSubmit={(event) => {
            void save(event);
          }}
        >
          <header className="flex min-h-20 flex-wrap items-center justify-between gap-4 px-6 py-4 sm:px-8">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{editing ? '正在编辑' : '文档'}</span>
              <Badge variant="secondary">{documentKey(document.number)}</Badge>
              <Badge variant="outline">v{document.version}</Badge>
              <span>
                更新于{' '}
                {new Date(document.updatedAt).toLocaleString('zh-CN', {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            {editing ? (
              <div className="flex items-center gap-3">
                <span
                  className="hidden text-xs text-muted-foreground sm:inline"
                  role="status"
                >
                  {busy ? '正在保存…' : dirty ? '有未保存的修改' : '没有修改'}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || navigationBusy || uploading}
                  onClick={() => {
                    void cancel();
                  }}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    busy || navigationBusy || uploading || !dirty || conflict
                  }
                >
                  {busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <SaveIcon data-icon="inline-start" />
                  )}
                  保存修改
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={busy || navigationBusy}
                onClick={() => {
                  setNotice('');
                  setEditing(true);
                }}
              >
                <PencilIcon data-icon="inline-start" />
                编辑
              </Button>
            )}
          </header>
          <Separator />
          <div className="flex flex-col gap-6 px-6 py-6 sm:px-8">
            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>
                  {conflict ? '文档版本发生冲突' : '修改未完成'}
                </AlertTitle>
                <AlertDescription>
                  <p>{error}</p>
                  {conflict && (
                    <p>请先复制需要保留的草稿，再加载最新版本继续编辑。</p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || navigationBusy}
                    onClick={() => {
                      void reload();
                    }}
                  >
                    {dirty ? '加载最新版本（放弃草稿）' : '加载最新版本'}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {uploadError && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>图片上传失败</AlertTitle>
                <AlertDescription>{uploadError}</AlertDescription>
              </Alert>
            )}
            {notice && !dirty && (
              <Alert role="status">
                <CheckIcon />
                <AlertTitle>{notice}</AlertTitle>
              </Alert>
            )}
            {editing ? (
              <FieldGroup>
                <Field data-disabled={busy || navigationBusy}>
                  <FieldLabel htmlFor="document-title">文档标题</FieldLabel>
                  <Input
                    id="document-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                    maxLength={200}
                    disabled={busy || navigationBusy}
                  />
                </Field>
                <Field data-disabled={busy || navigationBusy}>
                  <FieldLabel id="document-body-label">文档正文</FieldLabel>
                  <div className="min-w-0 rounded-lg border">
                    <RichTextEditor
                      key={editorKey}
                      labelId="document-body-label"
                      markdown={body}
                      disabled={busy || navigationBusy}
                      onChange={setBody}
                      onLoad={(markdown) => {
                        setBody(markdown);
                        setBaseline(markdown);
                      }}
                      uploading={uploading}
                      onImages={(files, insert) => {
                        void upload(files, insert);
                      }}
                    />
                  </div>
                  <FieldDescription>
                    {body.length.toLocaleString()} / 200,000 字符 · 输入 # 、-
                    、1. 、&gt; 、```
                    可以快速转换格式；光标在表格里时，工具栏下方出现增删行列的按钮。可以粘贴或拖入图片，只有工作空间成员能看到。每次正式保存都会留下可比较的版本。
                  </FieldDescription>
                </Field>
              </FieldGroup>
            ) : (
              <article className="flex min-w-0 flex-col gap-6">
                <h1 className="text-3xl font-semibold wrap-anywhere">
                  {document.title}
                </h1>
                {document.body ? (
                  <DocumentContent markdown={document.body} />
                ) : (
                  <Empty className="border border-dashed">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <FileTextIcon />
                      </EmptyMedia>
                      <EmptyTitle>这篇文档还没有正文</EmptyTitle>
                      <EmptyDescription>
                        进入编辑，写下需求、方案或一个待讨论的问题。
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <Button
                        type="button"
                        disabled={busy || navigationBusy}
                        onClick={() => setEditing(true)}
                      >
                        <PencilIcon data-icon="inline-start" />
                        开始编辑
                      </Button>
                    </EmptyContent>
                  </Empty>
                )}
              </article>
            )}
          </div>
        </form>
      </section>
      <aside
        className="flex min-w-0 flex-col gap-6 border-t bg-muted/20 p-6 xl:border-t-0 xl:border-l"
        aria-label="版本历史"
      >
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HistoryIcon className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">版本历史</h2>
          </div>
          <Badge variant="secondary">{revisions.length} 个版本</Badge>
        </header>
        {historyLoading && (
          <div className="flex flex-col gap-3" role="status">
            <span className="sr-only">正在加载历史…</span>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {historyError && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>历史加载失败</AlertTitle>
            <AlertDescription>
              <p>{historyError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setHistoryLoading(true);
                  setRetry(retry + 1);
                }}
              >
                重试历史加载
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <ToggleGroup
          aria-label="选择历史版本"
          orientation="vertical"
          spacing={1}
          className="max-h-72 w-full overflow-y-auto"
          value={selected ? [String(selected.version)] : []}
          onValueChange={(values) => {
            if (values[0]) setSelectedVersion(Number(values[0]));
          }}
        >
          {revisions.map((revision) => (
            <ToggleGroupItem
              key={revision.version}
              value={String(revision.version)}
              className="h-auto w-full justify-start px-3 py-3"
            >
              <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">v{revision.version}</Badge>
                  <span>
                    {kindLabels[revision.kind]}
                    {revision.restoredFromVersion
                      ? ` · 来自 v${revision.restoredFromVersion}`
                      : ''}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {revision.actorName} ·{' '}
                  {new Date(revision.createdAt).toLocaleString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {selected && (
          <>
            <Separator />
            <section className="flex flex-col gap-4" aria-label="版本差异">
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {previous
                      ? `v${previous.version} → v${selected.version}`
                      : `创建 v${selected.version}`}
                  </h3>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-diff-removed-foreground">− 删除</span>
                    <span className="text-diff-added-foreground">＋ 新增</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  与{previous ? '上一版本' : '空白文档'}比较 · 标题和正文
                </p>
              </div>
              {changes ? (
                <pre className="max-h-96 overflow-y-auto rounded-lg border bg-background py-3 font-mono text-xs leading-6 whitespace-pre-wrap wrap-anywhere">
                  {changes.map((part, index) => (
                    <span
                      key={index}
                      className={cn(
                        part.added && 'diff-added',
                        part.removed && 'diff-removed',
                      )}
                    >
                      {part.value.split('\n').map((line, lineIndex, lines) =>
                        lineIndex === lines.length - 1 && line === '' ? null : (
                          <span className="block px-3" key={lineIndex}>
                            <span
                              aria-hidden="true"
                              className="inline-block w-4 select-none"
                            >
                              {part.added ? '+' : part.removed ? '−' : ' '}
                            </span>
                            {line}
                            {'\n'}
                          </span>
                        ),
                      )}
                    </span>
                  ))}
                </pre>
              ) : (
                <Alert>
                  <AlertTitle>差异较大</AlertTitle>
                  <AlertDescription>
                    暂时无法快速计算差异，请对照所选版本的完整内容。
                  </AlertDescription>
                </Alert>
              )}
              {!changes && (
                <pre className="max-h-96 overflow-auto rounded-lg border p-3 text-xs whitespace-pre-wrap wrap-anywhere">
                  {selected.title}
                  {'\n\n'}
                  {selected.body}
                </pre>
              )}
              <Button
                variant="outline"
                className="w-full"
                disabled={
                  busy ||
                  navigationBusy ||
                  selected.version === document.version
                }
                onClick={() => {
                  void restore(selected.version);
                }}
              >
                <RotateCcwIcon data-icon="inline-start" />
                {selected.version === document.version
                  ? '这是当前版本'
                  : `恢复到 v${selected.version} 的内容`}
              </Button>
              <p className="text-xs leading-6 text-muted-foreground">
                恢复会创建新版本，保留全部历史。
              </p>
            </section>
          </>
        )}
      </aside>
      {confirmationDialog}
    </div>
  );
}
