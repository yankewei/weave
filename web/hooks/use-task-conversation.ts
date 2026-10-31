import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import {
  conversationMessageInputSchema,
  conversationPageSchema,
  conversationReceiptSchema,
  conversationStateSchema,
  type Conversation,
} from '@/lib/contracts';
import { watchConversation } from '@/lib/conversation-stream';

function mergeMessages(
  previous: Conversation['messages'],
  incoming: Conversation['messages'],
) {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

// If a disconnected client missed more than one snapshot window, start paging
// from the new window. Keeping the old cursor would silently skip the gap.
export function mergeLivePage(
  old: Pick<Conversation, 'messages' | 'nextCursor'> | null,
  page: Pick<Conversation, 'messages' | 'nextCursor'>,
) {
  const previous = old?.messages ?? [];
  const ids = new Set(previous.map((message) => message.id));
  const gap =
    previous.length > 0 &&
    page.messages.length > 0 &&
    !page.messages.some((message) => ids.has(message.id)) &&
    page.messages[0]!.createdAt >= previous[previous.length - 1]!.createdAt;
  return {
    messages: mergeMessages(previous, page.messages),
    nextCursor:
      !old || (gap && page.nextCursor) ? page.nextCursor : old.nextCursor,
  };
}

type PendingInput = ReturnType<typeof conversationMessageInputSchema.parse>;

// The caller keys the component by user/project; all requests share that mount's cancellation scope.
export function useTaskConversation(projectId: string, userId: string) {
  const storageKey = `weave.input/${userId}/${projectId}`;
  const [retryInput, setRetryInput] = useState<PendingInput | null>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored
        ? conversationMessageInputSchema.parse(JSON.parse(stored))
        : null;
    } catch {
      return null;
    }
  });
  const [draft, setDraft] = useState(retryInput?.body ?? '');
  const [unavailable, setUnavailable] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [paging, setPaging] = useState(false);
  const [reload, setReload] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const posting = useRef(false);
  const acceptedRequest = useRef<string | null>(null);
  const pageLoading = useRef(false);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const scope = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          scope.signal.removeEventListener('abort', finish);
          resolve();
        };
        timer = setTimeout(finish, ms);
        scope.signal.addEventListener('abort', finish, { once: true });
      });
    async function follow() {
      let attempts = 0;
      while (!scope.signal.aborted) {
        try {
          const { conversation: fresh } = await api(
            `/projects/${projectId}/conversation`,
            conversationStateSchema,
            { signal: scope.signal },
          );
          if (scope.signal.aborted) return;
          setLoading(false);
          setReconnecting(false);
          if (fresh) {
            setConversation((old) => ({
              ...fresh,
              ...mergeLivePage(old, fresh),
            }));
            if (fresh.run?.inputStatus === 'accepted') {
              const acceptedId = fresh.run.requestId;
              acceptedRequest.current = acceptedId;
              try {
                const stored = sessionStorage.getItem(storageKey);
                if (
                  stored &&
                  conversationMessageInputSchema.parse(JSON.parse(stored))
                    .requestId === acceptedId
                ) {
                  sessionStorage.removeItem(storageKey);
                  setDraft('');
                  setError('');
                }
              } catch {
                /* Receipt is already durable. */
              }
              setRetryInput((pending) =>
                pending?.requestId === acceptedId ? null : pending,
              );
            }
          }
          if (
            !fresh ||
            !fresh.run ||
            ['succeeded', 'failed'].includes(fresh.run.status)
          ) {
            attempts = 0;
            await pause(fresh?.run?.syncStatus === 'pending' ? 1500 : 10_000);
            continue;
          }
          const subscription = new AbortController();
          let terminal = false;
          await watchConversation(
            fresh.id,
            AbortSignal.any([scope.signal, subscription.signal]),
            (snapshot) => {
              attempts = 0;
              setReconnecting(false);
              setConversation((old) => {
                if (
                  !old ||
                  old.id !== snapshot.conversationId ||
                  !old.run ||
                  old.run.id !== snapshot.run?.id
                )
                  return old;
                return {
                  ...old,
                  ...mergeLivePage(old, snapshot),
                  run: { ...old.run, ...snapshot.run },
                };
              });
              if (
                snapshot.run &&
                ['succeeded', 'failed'].includes(snapshot.run.status)
              ) {
                terminal = true;
                subscription.abort();
              }
            },
          ).catch((caught: unknown) => {
            if (!terminal) throw caught;
          });
          if (terminal) continue; // Read PHP's proposal and callback synchronization status.
          if (scope.signal.aborted) return;
          throw new Error('对话连接已中断，正在重新连接。');
        } catch (caught) {
          if (scope.signal.aborted) return;
          setLoading(false);
          if (
            caught instanceof ApiError &&
            [401, 403, 404].includes(caught.status)
          ) {
            if (caught.status === 401) window.location.assign('/login');
            setError(caught.message);
            setUnavailable(true);
            setConversation(null);
            return;
          }
          setReconnecting(true);
          await pause(Math.min(1000 * 2 ** attempts++, 15_000));
        }
      }
    }
    void follow();
    return () => {
      scope.abort();
      clearTimeout(timer);
    };
  }, [projectId, reload, storageKey]);

  const send = useCallback(
    async (body: string, retry = false) => {
      const scope = lifetime.current;
      if (
        !scope ||
        scope.signal.aborted ||
        posting.current ||
        (!retry && retryInput)
      )
        return false;
      const parsed = conversationMessageInputSchema.safeParse(
        retry ? retryInput : { requestId: crypto.randomUUID(), body },
      );
      if (!parsed.success) {
        setError('请输入 1 到 8000 个字符。');
        return false;
      }
      const input = parsed.data;
      setDraft(input.body);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(input));
      } catch {
        setError('无法保存发送凭据，请启用浏览器会话存储后重试。');
        return false;
      }
      posting.current = true;
      setRetryInput(input);
      setSending(true);
      setError('');
      try {
        const receipt = await api(
          `/projects/${projectId}/conversation/messages`,
          conversationReceiptSchema,
          {
            method: 'POST',
            body: JSON.stringify(input),
            signal: scope.signal,
          },
        );
        if (receipt.requestId !== input.requestId)
          throw new Error('消息接收凭据不匹配。');
        if (scope.signal.aborted) return false;
        acceptedRequest.current = input.requestId;
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* Already accepted. */
        }
        setRetryInput(null);
        setDraft('');
        refresh();
        return true;
      } catch (caught) {
        if (scope.signal.aborted) return false;
        if (acceptedRequest.current === input.requestId) {
          refresh();
          return true;
        }
        // Proxy failures/timeouts can hide an accepted input. Keep its original id for explicit retry.
        if (
          caught instanceof ApiError &&
          caught.status >= 400 &&
          caught.status < 500 &&
          caught.status !== 408
        ) {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            /* Keep the in-memory result. */
          }
          setRetryInput(null);
        }
        setError(
          caught instanceof Error
            ? caught.message
            : '发送结果未知，请使用原消息重试。',
        );
        refresh();
        return false;
      } finally {
        posting.current = false;
        if (!scope.signal.aborted) setSending(false);
      }
    },
    [projectId, refresh, retryInput, storageKey],
  );

  async function loadEarlier() {
    if (!conversation?.nextCursor || pageLoading.current) return;
    pageLoading.current = true;
    setPaging(true);
    const scope = lifetime.current;
    try {
      const page = await api(
        `/conversations/${conversation.id}/messages?cursor=${encodeURIComponent(conversation.nextCursor)}`,
        conversationPageSchema,
        { signal: scope?.signal ?? null },
      );
      if (scope?.signal.aborted) return;
      setConversation(
        (old) =>
          old && {
            ...old,
            messages: mergeMessages(page.messages, old.messages),
            nextCursor: page.nextCursor,
          },
      );
    } catch (caught) {
      if (!scope?.signal.aborted)
        setError(caught instanceof Error ? caught.message : '消息加载失败。');
    } finally {
      pageLoading.current = false;
      if (!scope?.signal.aborted) setPaging(false);
    }
  }

  return {
    draft,
    setDraft,
    unavailable,
    conversation,
    loading,
    sending,
    error,
    setError,
    reconnecting,
    retryInput,
    send,
    refresh,
    loadEarlier,
    paging,
  };
}
