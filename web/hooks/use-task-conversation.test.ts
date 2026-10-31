import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '@/lib/api';
import { watchConversation } from '@/lib/conversation-stream';
import type { Conversation } from '@/lib/contracts';
import { mergeLivePage, useTaskConversation } from './use-task-conversation';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: vi.fn(),
}));
vi.mock('@/lib/conversation-stream', () => ({ watchConversation: vi.fn() }));
const project = '44352a48-c54f-437c-a65c-99e2bc7ca8d5';
const user = 'd60d90e2-97e6-4f39-8abb-aa1f740b7266';
const id = 'd6e334c8-cdbb-4628-86bc-a53b042a8db2';
const requestId = '70bd014a-611d-496e-8f4a-42f62f03e64c';
const runId = '7bcbf4a3-bd33-4db5-8a2c-a6d5dec9f7c7';
const message = (body: string, time: string) => ({
  id: crypto.randomUUID(),
  body,
  createdAt: time,
  authorType: 'user' as const,
  authorName: '你',
});
let state: Conversation | null;
let snapshot: Parameters<typeof watchConversation>[2];
let disconnect: (() => void) | undefined;
beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  state = null;
  vi.mocked(api).mockImplementation(async () => ({ conversation: state }));
  vi.mocked(watchConversation).mockImplementation(
    async (_id, signal, onSnapshot) => {
      snapshot = onSnapshot;
      await new Promise<void>((resolve) => {
        disconnect = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('retains the original input id after timeout and refresh; never resends automatically', async () => {
  const sent: string[] = [];
  vi.mocked(api).mockImplementation(async (_path, _schema, options) => {
    if (options?.method !== 'POST') return { conversation: state };
    sent.push(String(options.body));
    if (sent.length === 1) throw new ApiError(503, '暂不可用');
    const input = JSON.parse(String(options.body));
    return {
      conversationId: id,
      runId,
      requestId: input.requestId,
      status: 'accepted',
    };
  });
  const first = renderHook(() => useTaskConversation(project, user));
  await waitFor(() => expect(first.result.current.loading).toBe(false));
  await act(async () => {
    await first.result.current.send('一个目标');
  });
  const pending = first.result.current.retryInput;
  expect(pending?.body).toBe('一个目标');
  first.unmount();
  const restored = renderHook(() => useTaskConversation(project, user));
  await waitFor(() => expect(restored.result.current.loading).toBe(false));
  expect(restored.result.current.retryInput).toEqual(pending);
  expect(sent).toHaveLength(1);
  await act(async () => {
    await restored.result.current.send('一个目标', true);
  });
  expect(sent[1]).toEqual(sent[0]);
  expect(restored.result.current.retryInput).toBeNull();
});

it('keeps earlier pages through snapshot updates and cancels the subscription on unmount', async () => {
  const earlier = message('更早消息', '2026-10-30T00:00:00Z');
  const recent = message('最近消息', '2026-10-31T00:00:00Z');
  const next = message('新消息', '2026-10-31T00:01:00Z');
  state = {
    id,
    workspaceId: user,
    projectId: project,
    messages: [recent],
    nextCursor: 'cursor',
    proposal: null,
    run: {
      id: runId,
      requestId,
      status: 'running',
      reply: '',
      message: null,
      inputStatus: 'accepted',
      syncStatus: 'pending',
    },
  };
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('/messages?cursor=')
      ? { messages: [earlier], nextCursor: null }
      : { conversation: state },
  );
  const view = renderHook(() => useTaskConversation(project, user));
  await waitFor(() => expect(watchConversation).toHaveBeenCalledOnce());
  await act(async () => {
    await view.result.current.loadEarlier();
  });
  act(() =>
    snapshot({
      conversationId: id,
      messages: [recent, next],
      nextCursor: 'stale',
      run: state!.run,
    }),
  );
  expect(
    view.result.current.conversation?.messages.map((item) => item.body),
  ).toEqual(['更早消息', '最近消息', '新消息']);
  expect(view.result.current.conversation?.nextCursor).toBeNull();
  const signal = vi.mocked(watchConversation).mock.calls[0]![1];
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it('reconnects from PHP state after a dropped stream without sending another input', async () => {
  state = {
    id,
    workspaceId: user,
    projectId: project,
    messages: [],
    nextCursor: null,
    proposal: null,
    run: {
      id: runId,
      requestId,
      status: 'running',
      reply: '',
      message: null,
      inputStatus: 'accepted',
      syncStatus: 'pending',
    },
  };
  const view = renderHook(() => useTaskConversation(project, user));
  await waitFor(() => expect(watchConversation).toHaveBeenCalledOnce());
  await act(async () => {
    disconnect?.();
  });
  expect(view.result.current.reconnecting).toBe(true);
  await waitFor(() => expect(watchConversation).toHaveBeenCalledTimes(2), {
    timeout: 2000,
  });
  expect(
    vi.mocked(api).mock.calls.every(([, , options]) => !options?.method),
  ).toBe(true);
});

it('isolates pending inputs by both user and project and honors definitive rejection', async () => {
  sessionStorage.setItem(
    `weave.input/${user}/${project}`,
    JSON.stringify({ requestId, body: '私有目标' }),
  );
  const other = renderHook(() => useTaskConversation(project, id));
  await waitFor(() => expect(other.result.current.loading).toBe(false));
  expect(other.result.current.retryInput).toBeNull();
  other.unmount();
  const own = renderHook(() => useTaskConversation(project, user));
  await waitFor(() => expect(own.result.current.loading).toBe(false));
  vi.mocked(api).mockImplementation(async (_path, _schema, options) => {
    if (options?.method === 'POST') throw new ApiError(409, '请先处理提案');
    return { conversation: null };
  });
  await act(async () => {
    await own.result.current.send('私有目标', true);
  });
  expect(own.result.current.retryInput).toBeNull();
  expect(sessionStorage.getItem(`weave.input/${user}/${project}`)).toBeNull();
});

it('polls terminal runs until PHP has synchronized the result, without opening another stream', async () => {
  state = {
    id,
    workspaceId: user,
    projectId: project,
    messages: [],
    nextCursor: null,
    proposal: null,
    run: {
      id: runId,
      requestId,
      status: 'succeeded',
      reply: '',
      message: null,
      inputStatus: 'accepted',
      syncStatus: 'pending',
    },
  };
  const view = renderHook(() => useTaskConversation(project, user));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.conversation?.run?.syncStatus).toBe('pending');
  state = { ...state, run: { ...state.run!, syncStatus: 'complete' } };
  await waitFor(
    () =>
      expect(view.result.current.conversation?.run?.syncStatus).toBe(
        'complete',
      ),
    { timeout: 2500 },
  );
  expect(watchConversation).not.toHaveBeenCalled();
});

it('stops reading and clears private messages when access is revoked', async () => {
  vi.mocked(api).mockRejectedValue(new ApiError(403, '无权访问'));
  const view = renderHook(() => useTaskConversation(project, user));
  await waitFor(() => expect(view.result.current.unavailable).toBe(true));
  expect(view.result.current.conversation).toBeNull();
  expect(watchConversation).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledOnce();
});

it('uses a new scan cursor to bridge a missed snapshot window without losing loaded messages', () => {
  const old = {
    messages: [message('旧页', '2026-10-20')],
    nextCursor: 'old-scan',
  };
  const newest = {
    messages: [message('新页', '2026-10-31')],
    nextCursor: 'new-scan',
  };
  const merged = mergeLivePage(old, newest);
  expect(merged.messages.map((item) => item.body)).toEqual(['旧页', '新页']);
  expect(merged.nextCursor).toBe('new-scan');
  expect(mergeLivePage(merged, newest).nextCursor).toBe('new-scan');
});
