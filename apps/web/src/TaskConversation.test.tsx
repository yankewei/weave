import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskConversation } from './TaskConversation.js';

const projectId = '00000000-0000-4000-8000-000000000010';
const proposalId = '00000000-0000-4000-8000-000000000011';

describe('task conversation', () => {
  it('shows a proposal and creates tasks only after confirmation', async () => {
    let streamController:
      ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/conversation') && !options?.method)
        return Response.json({ conversation: null });
      if (String(url).endsWith('/messages')) {
        expect(JSON.parse(options!.body as string)).toEqual({
          body: '给注册加上失败提示',
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              streamController = controller;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (String(url).endsWith('/confirm'))
        return Response.json({
          conversation: {
            id: '00000000-0000-4000-8000-000000000012',
            workspaceId: '00000000-0000-4000-8000-000000000013',
            projectId,
            messages: [
              {
                id: '00000000-0000-4000-8000-000000000014',
                authorType: 'user',
                authorName: '林',
                body: '给注册加上失败提示',
                createdAt: '2026-10-16T00:00:00.000Z',
              },
            ],
            proposal: {
              id: proposalId,
              status: 'applied',
              summary: '可以拆成一项。',
              items: [
                {
                  id: '00000000-0000-4000-8000-000000000016',
                  title: '显示注册失败原因',
                  description: '来源不被信任时说明原因',
                  acceptanceCriteria: '页面能看到具体错误',
                  priority: 'high',
                  taskId: '00000000-0000-4000-8000-000000000017',
                  taskNumber: 3,
                },
              ],
            },
          },
        });
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const finished = {
      conversation: {
        id: '00000000-0000-4000-8000-000000000012',
        workspaceId: '00000000-0000-4000-8000-000000000013',
        projectId,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000014',
            authorType: 'user',
            authorName: '林',
            body: '给注册加上失败提示',
            createdAt: '2026-10-16T00:00:00.000Z',
          },
          {
            id: '00000000-0000-4000-8000-000000000015',
            authorType: 'assistant',
            authorName: null,
            body: '可以拆成一项。',
            createdAt: '2026-10-16T00:00:01.000Z',
          },
        ],
        proposal: {
          id: proposalId,
          status: 'pending',
          summary: '可以拆成一项。',
          items: [
            {
              id: '00000000-0000-4000-8000-000000000016',
              title: '显示注册失败原因',
              description: '来源不被信任时说明原因',
              acceptanceCriteria: '页面能看到具体错误',
              priority: 'high',
              taskId: null,
              taskNumber: null,
            },
          ],
        },
      },
    };
    vi.stubGlobal('fetch', fetchMock);
    const openBoard = vi.fn();
    const minimize = vi.fn();
    render(
      <TaskConversation
        projectId={projectId}
        projectName="第一步"
        onOpenBoard={openBoard}
        onMinimize={minimize}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: '从这个项目的一件事开始' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('想做的事'), {
      target: { value: '给注册加上失败提示' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送给 AI' }));
    streamController!.enqueue(
      encoder.encode('event: reply\ndata: {"reply":"可以拆"}\n\n'),
    );
    expect(await screen.findByText('可以拆')).toBeInTheDocument();
    streamController!.enqueue(
      encoder.encode(`event: done\ndata: ${JSON.stringify(finished)}\n\n`),
    );
    streamController!.close();
    expect(await screen.findByText('可以拆成一项。')).toBeInTheDocument();
    expect(screen.getByText('显示注册失败原因')).toBeInTheDocument();
    expect(screen.getByLabelText('想做的事')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '确认并创建任务' }));
    expect(await screen.findByText('WV-3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '在看板中查看' }));
    expect(openBoard).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '缩小' }));
    expect(minimize).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
