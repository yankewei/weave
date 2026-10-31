import { afterEach, expect, it, vi } from 'vitest';
import { watchConversation } from './conversation-stream';
import { ApiError } from './api';

const id = 'a891466c-5cab-42f5-bebe-d6abf6c066fa';
afterEach(() => vi.unstubAllGlobals());

it('decodes UTF-8 and CRLF split across chunks, ignores heartbeats and replaces snapshots', async () => {
  const snapshots = [
    { conversationId: id, messages: [], nextCursor: null, run: null },
    {
      conversationId: id,
      messages: [
        {
          id,
          authorType: 'assistant',
          authorName: null,
          body: '你好',
          createdAt: '2026-10-31T00:00:00Z',
        },
      ],
      nextCursor: null,
      run: null,
    },
  ];
  const bytes = new TextEncoder().encode(
    ': heartbeat\r\n\r\n' +
      snapshots
        .map(
          (snapshot) =>
            `event:snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r\n`,
        )
        .join(''),
  );
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const fetch = vi.fn().mockResolvedValue(
    new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const received = vi.fn();
  await watchConversation(id, new AbortController().signal, received);
  expect(received.mock.calls.map(([snapshot]) => snapshot)).toEqual(snapshots);
  expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
  expect(stream.locked).toBe(false);
});

it('cancels its reader on invalid or foreign snapshots and reports authorization failures', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'event: snapshot\ndata: {"conversationId":"invalid"}\n\n',
        ),
      );
    },
    cancel,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ),
  );
  await expect(
    watchConversation(id, new AbortController().signal, vi.fn()),
  ).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
  );
  await expect(
    watchConversation(id, new AbortController().signal, vi.fn()),
  ).rejects.toEqual(new ApiError(403, '对话订阅暂不可用。'));
});
