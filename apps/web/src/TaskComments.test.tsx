import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskComment } from '@weave/contracts';
import { TaskComments } from './TaskComments.js';

const taskId = '00000000-0000-4000-8000-000000000010';
const userId = '00000000-0000-4000-8000-000000000001';
const base: TaskComment = {
  id: '00000000-0000-4000-8000-000000000011',
  taskId,
  parentId: null,
  authorId: userId,
  authorName: '林',
  body: '初始评论',
  createdAt: '2026-10-17T12:00:00.000Z',
};
const reply: TaskComment = {
  ...base,
  id: '00000000-0000-4000-8000-000000000012',
  parentId: base.id,
  body: '已有回复',
  createdAt: '2026-10-17T12:01:00.000Z',
};

describe('task comments', () => {
  it('shows comments and posts a reply under its root comment', async () => {
    let nextId = 13;
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/comments') && !options?.method)
        return Response.json([base, reply]);
      if (String(url).endsWith('/comments') && options?.method === 'POST') {
        const input = JSON.parse(options.body as string) as {
          body: string;
          parentId: string | null;
        };
        return Response.json(
          {
            ...base,
            id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
            body: input.body,
            parentId: input.parentId,
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<TaskComments taskId={taskId} currentUserId={userId} />);

    expect(await screen.findByText('初始评论')).toBeInTheDocument();
    expect(screen.getByText('已有回复')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '回复' }));
    fireEvent.change(await screen.findByLabelText('回复林'), {
      target: { value: '新回复' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送回复' }));

    expect(
      await screen.findByText('新回复', { selector: 'p' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${taskId}/comments`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: '新回复', parentId: base.id }),
      }),
    );

    fireEvent.change(screen.getByLabelText('写评论'), {
      target: { value: '新评论' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发表评论' }));
    expect(
      await screen.findByText('新评论', { selector: 'p' }),
    ).toBeInTheDocument();
  });

  it('deletes a comment after confirmation and removes its replies', async () => {
    let deleted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, options) => {
        if (options?.method === 'DELETE') {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        if (String(url).endsWith('/comments'))
          return Response.json(deleted ? [] : [base, reply]);
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    render(<TaskComments taskId={taskId} currentUserId={userId} />);
    expect(await screen.findByText('初始评论')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除评论：初始评论' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除评论' }));
    expect(await screen.findByText('还没有评论')).toBeInTheDocument();
    expect(screen.queryByText('已有回复')).not.toBeInTheDocument();
  });
});
