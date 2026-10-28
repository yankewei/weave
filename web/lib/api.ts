export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Centralize HTTP errors and runtime decoding; never trust a successful status alone.
export async function api<T>(
  path: string,
  schema: { parse: (value: unknown) => T },
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, signal, headers, ...rest } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`/api${path}`, {
    ...rest,
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      // The browser sets the multipart boundary for FormData itself.
      ...(rest.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      'X-Weave-Request': '1',
      ...headers,
    },
  });
  if (!response.ok) {
    let message = '请求失败，请稍后重试。';
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* Proxies can return non-JSON errors. */
    }
    // The session cookie expired; start over from the login page.
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.location.assign('/login');
    throw new ApiError(response.status, message);
  }
  return schema.parse(response.status === 204 ? null : await response.json());
}

export async function apiEventStream(
  path: string,
  options: {
    body: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onReply: (reply: string) => void;
  },
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 70_000);
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    body: options.body,
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Weave-Request': '1',
    },
  });
  if (!response.ok) {
    let message = '请求失败，请稍后重试。';
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* Proxies can return non-JSON errors. */
    }
    if (response.status === 401) window.location.assign('/login');
    throw new ApiError(response.status, message);
  }
  if (!response.body)
    throw new ApiError(502, '模型没有返回提案，没有创建任务。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload: unknown;
  const consume = (block: string) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const dataLine = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');
    if (!event || !dataLine) return;
    const data = JSON.parse(dataLine) as {
      reply?: unknown;
      message?: unknown;
    };
    if (event === 'reply' && typeof data.reply === 'string')
      options.onReply(data.reply);
    if (event === 'done') donePayload = data;
    if (event === 'error') {
      throw new ApiError(
        502,
        typeof data.message === 'string' ? data.message : '生成提案失败。',
      );
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) consume(block);
  }
  if (buffer.trim()) consume(buffer);
  if (donePayload === undefined)
    throw new ApiError(502, '模型没有返回提案，没有创建任务。');
  return donePayload;
}
