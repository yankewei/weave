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
