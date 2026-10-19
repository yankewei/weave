'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { taskCommentSchema, type TaskComment } from '@/lib/contracts';
import { MessageSquareIcon, Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { useConfirmation } from '@/hooks/use-confirmation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

function formatCommentTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function CommentItem({
  comment,
  currentUserId,
  isReply,
  busy,
  onReply,
  onDelete,
}: {
  comment: TaskComment;
  currentUserId: string;
  isReply: boolean;
  busy: boolean;
  onReply?: () => void;
  onDelete: () => void;
}) {
  const mine = comment.authorId === currentUserId;
  return (
    <article className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{comment.authorName}</span>
        {mine && <Badge variant="outline">你</Badge>}
        <time
          className="text-xs text-muted-foreground"
          dateTime={comment.createdAt}
        >
          {formatCommentTime(comment.createdAt)}
        </time>
      </div>
      <p className="text-sm leading-6 whitespace-pre-wrap wrap-anywhere">
        {comment.body}
      </p>
      {(!isReply && onReply) || mine ? (
        <div className="flex items-center gap-1">
          {!isReply && onReply ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onReply}
            >
              回复
            </Button>
          ) : null}
          {mine ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`删除评论：${comment.body.slice(0, 20)}`}
              onClick={onDelete}
            >
              <Trash2Icon data-icon="inline-start" />
              删除
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function TaskComments({
  taskId,
  currentUserId,
}: {
  taskId: string;
  currentUserId: string;
}) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<TaskComment | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { confirm, confirmationDialog } = useConfirmation();

  useEffect(() => {
    const controller = new AbortController();
    api(`/tasks/${taskId}/comments`, taskCommentSchema.array(), {
      signal: controller.signal,
    })
      .then((rows) => {
        if (controller.signal.aborted) return;
        setComments(rows);
        setError('');
        setLoadFailed(false);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
          setError(caught instanceof Error ? caught.message : '评论加载失败。');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry, taskId]);

  const roots = useMemo(
    () => comments.filter((comment) => comment.parentId === null),
    [comments],
  );
  const repliesFor = (commentId: string) =>
    comments.filter((comment) => comment.parentId === commentId);
  const pending = busy || deletingId !== null;

  async function createComment(body: string, parentId: string | null) {
    const value = body.trim();
    if (!value || pending) return;
    setBusy(true);
    setError('');
    try {
      const created = await api(
        `/tasks/${taskId}/comments`,
        taskCommentSchema,
        {
          method: 'POST',
          body: JSON.stringify({ body: value, parentId }),
        },
      );
      setComments((current) => [...current, created]);
      if (parentId) {
        setReplyTo(null);
        setReplyDraft('');
      } else {
        setDraft('');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '评论发送失败。');
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(comment: TaskComment) {
    const replyCount = repliesFor(comment.id).length;
    if (
      !(await confirm({
        title: '删除这条评论？',
        description:
          replyCount > 0
            ? `这条评论下的 ${replyCount} 条回复也会一并删除。`
            : '删除后不能恢复。',
        confirmLabel: '删除评论',
      }))
    )
      return;
    setDeletingId(comment.id);
    setError('');
    try {
      await api(
        `/tasks/${taskId}/comments/${comment.id}`,
        { parse: () => null },
        {
          method: 'DELETE',
        },
      );
      setComments((current) =>
        current.filter(
          (item) => item.id !== comment.id && item.parentId !== comment.id,
        ),
      );
      if (replyTo?.id === comment.id) setReplyTo(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '评论删除失败。');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section aria-label="任务评论" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquareIcon className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">评论</h3>
        </div>
        <Badge variant="secondary">{comments.length}</Badge>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>评论加载或发送失败</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                setError('');
                setLoadFailed(false);
                setLoading(true);
                setRetry((value) => value + 1);
              }}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <div className="flex flex-col gap-3" role="status">
          <span className="sr-only">正在加载评论…</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : loadFailed && comments.length === 0 ? null : comments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquareIcon />
            </EmptyMedia>
            <EmptyTitle>还没有评论</EmptyTitle>
            <EmptyDescription>
              写下问题、决定或进展，也可以回复其他人的评论。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-5">
          {roots.map((comment) => (
            <div key={comment.id} className="flex flex-col gap-3">
              <CommentItem
                comment={comment}
                currentUserId={currentUserId}
                isReply={false}
                busy={pending}
                onReply={() => {
                  setReplyTo(comment);
                  setReplyDraft('');
                }}
                onDelete={() => {
                  void removeComment(comment);
                }}
              />
              {repliesFor(comment.id).length > 0 ? (
                <div className="ml-4 flex flex-col gap-3 border-l pl-3">
                  {repliesFor(comment.id).map((reply) => (
                    <CommentItem
                      key={reply.id}
                      comment={reply}
                      currentUserId={currentUserId}
                      isReply
                      busy={pending}
                      onDelete={() => {
                        void removeComment(reply);
                      }}
                    />
                  ))}
                </div>
              ) : null}
              {replyTo?.id === comment.id ? (
                <form
                  className="ml-4 flex flex-col gap-3 border-l pl-3"
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    void createComment(replyDraft, comment.id);
                  }}
                >
                  <FieldGroup>
                    <Field data-disabled={pending}>
                      <FieldLabel htmlFor={`reply-${comment.id}`}>
                        回复{comment.authorName}
                      </FieldLabel>
                      <Textarea
                        id={`reply-${comment.id}`}
                        value={replyDraft}
                        onChange={(event) => setReplyDraft(event.target.value)}
                        maxLength={4_000}
                        autoFocus
                        disabled={pending}
                        placeholder="写下你的回复…"
                      />
                    </Field>
                  </FieldGroup>
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={pending || replyDraft.trim() === ''}
                    >
                      {busy && <Spinner data-icon="inline-start" />}
                      发送回复
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setReplyTo(null);
                        setReplyDraft('');
                      }}
                    >
                      取消
                    </Button>
                  </div>
                </form>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {!loading && !(loadFailed && comments.length === 0) ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void createComment(draft, null);
          }}
        >
          <FieldGroup>
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="new-task-comment">写评论</FieldLabel>
              <Textarea
                id="new-task-comment"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={4_000}
                disabled={pending}
                placeholder="写下问题、决定或进展…"
              />
            </Field>
          </FieldGroup>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
              {busy && <Spinner data-icon="inline-start" />}
              发表评论
            </Button>
          </div>
        </form>
      ) : null}
      {confirmationDialog}
    </section>
  );
}
