import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

describe('application shell', () => {
  it('shows empty business panels and the actual API connection result', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ status: 'ok', service: 'weave-api' }),
        ),
    );

    render(<App />);

    expect(await screen.findByText('接口服务已连接')).toBeInTheDocument();
    expect(screen.getByText('这里还没有项目内容')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(screen.getByLabelText('向 AI 描述你的需求')).toBeDisabled();
  });

  it('shows a connection failure when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Connection refused')),
    );

    render(<App />);

    expect(await screen.findByText('接口服务不可用')).toBeInTheDocument();
  });

  it('rejects a successful HTTP response with an invalid body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));

    render(<App />);

    expect(await screen.findByText('接口服务不可用')).toBeInTheDocument();
  });

  it('does not report a failed HTTP request as a connected service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    render(<App />);

    expect(await screen.findByText('接口服务不可用')).toBeInTheDocument();
  });

  it('aborts the health request when the page is unmounted', () => {
    const fetchMock = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => undefined),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(<App />);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;

    unmount();

    expect(options.signal?.aborted).toBe(true);
  });
});
