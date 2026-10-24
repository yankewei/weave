import { conversationMessageInputSchema } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { ApiError, body, errorResponse, handler, uuid } from '@/lib/http';
import { send } from '@/lib/services/conversations';

export const dynamic = 'force-dynamic';
// The model timeout is 55s; keep the function alive long enough to flush the stream.
export const maxDuration = 120;

const encoder = new TextEncoder();

function frame(event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const POST = handler<{ projectId: string }>(
  async (request, { projectId }) => {
    const user = await requireUser();
    const input = await body(request, conversationMessageInputSchema);
    const project = uuid(projectId, '项目');
    const abort = new AbortController();
    const stop = () => abort.abort();
    request.signal.addEventListener('abort', stop);

    const queued: Uint8Array[] = [];
    // A mutable holder keeps TypeScript from narrowing the controller to null
    // inside the async producer below.
    const output: {
      controller: ReadableStreamDefaultController<Uint8Array> | null;
    } = { controller: null };
    let finished = false;
    let head: 'event' | 'done' | { error: unknown } | null = null;
    let settleHead:
      ((value: 'event' | 'done' | { error: unknown }) => void) | null = null;
    const opened = new Promise<'event' | 'done' | { error: unknown }>(
      (resolve) => {
        settleHead = resolve;
      },
    );
    const settle = (value: 'event' | 'done' | { error: unknown }) => {
      if (head) return;
      head = value;
      settleHead?.(value);
    };
    const emit = (event: string, data: unknown) => {
      const chunk = frame(event, data);
      if (output.controller) output.controller.enqueue(chunk);
      else queued.push(chunk);
      settle('event');
    };

    void (async () => {
      try {
        const result = await send(
          user.id,
          project,
          input.body,
          (reply) => emit('reply', { reply }),
          abort.signal,
          (summary) => emit('lookup', { summary }),
        );
        if (result) emit('done', result);
        settle('done');
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : '模型输出无法通过校验，没有创建任务。';
        if (output.controller) {
          output.controller.enqueue(frame('error', { message }));
          settle('done');
        } else {
          settle({ error });
        }
      } finally {
        finished = true;
        request.signal.removeEventListener('abort', stop);
        output.controller?.close();
      }
    })();

    // Wait for the first token or an early failure so errors keep their status code.
    const outcome = await opened;
    if (typeof outcome === 'object') return errorResponse(outcome.error);

    const bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        output.controller = controller;
        for (const chunk of queued.splice(0)) controller.enqueue(chunk);
        if (finished) controller.close();
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(bodyStream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
);
