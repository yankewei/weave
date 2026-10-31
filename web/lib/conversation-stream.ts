import { ApiError } from '@/lib/api';
import { conversationSnapshotSchema } from '@/lib/contracts';

// Snapshots replace the current view; SSE ids and token concatenation are intentionally absent.
export async function watchConversation(
  id: string,
  signal: AbortSignal,
  onSnapshot: (
    snapshot: ReturnType<typeof conversationSnapshotSchema.parse>,
  ) => void,
) {
  const connection = new AbortController();
  const combined = AbortSignal.any([signal, connection.signal]);
  let idle = setTimeout(() => connection.abort(), 45_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`/api/conversations/${id}/events`, {
      credentials: 'same-origin',
      headers: { Accept: 'text/event-stream', 'X-Weave-Request': '1' },
      signal: combined,
    });
    if (!response.ok) throw new ApiError(response.status, '对话订阅暂不可用。');
    if (
      !response.body ||
      !response.headers.get('content-type')?.startsWith('text/event-stream')
    )
      throw new ApiError(502, '对话订阅响应无效。');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let event = '';
    let data: string[] = [];
    while (!combined.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      clearTimeout(idle);
      idle = setTimeout(() => connection.abort(), 45_000);
      lineBuffer += decoder.decode(chunk.value, { stream: true });
      // Decode lines before frames, so CRLF split between two reads remains intact.
      let newline: number;
      while ((newline = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line === '') {
          if (event === 'snapshot' && data.length) {
            const snapshot = conversationSnapshotSchema.parse(
              JSON.parse(data.join('\n')),
            );
            if (snapshot.conversationId !== id)
              throw new Error('对话订阅标识不匹配。');
            if (!combined.aborted) onSnapshot(snapshot);
          }
          event = '';
          data = [];
        } else if (line.startsWith('event:')) event = line.slice(6).trimStart();
        else if (line.startsWith('data:'))
          data.push(line.slice(5).replace(/^ /, ''));
        if (combined.aborted) break;
      }
    }
  } finally {
    clearTimeout(idle);
    connection.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
