import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@weave/contracts';
import { TaskBoard } from './TaskBoard.js';

const projectId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const task: Task = {
  id: '00000000-0000-4000-8000-000000000003',
  workspaceId: userId,
  projectId,
  number: 1,
  title: '实现看板',
  description: '允许拖动卡片',
  acceptanceCriteria: '刷新后不丢失顺序',
  status: 'todo',
  priority: 'high',
  assigneeId: userId,
  assigneeName: '林',
  position: '1024',
  version: 1,
  updatedAt: '2026-10-16T12:00:00Z',
};
const second: Task = {
  ...task,
  id: '00000000-0000-4000-8000-000000000004',
  number: 2,
  title: '完善文档',
  status: 'done',
  priority: 'low',
  assigneeId: null,
  assigneeName: null,
  position: '2048',
};
const members = [{ id: userId, name: '林' }];

function board() {
  return render(
    <TaskBoard
      projectId={projectId}
      projectName="产品改进"
      currentUserId={userId}
      onDirtyChange={vi.fn()}
      onBusyChange={vi.fn()}
    />,
  );
}

describe('persisted task board', () => {
  it('groups real tasks into columns and filters by text, priority and assignee', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) =>
        Response.json(
          String(url).endsWith('/members') ? members : [task, second],
        ),
      ),
    );
    board();
    expect(
      await screen.findByRole('button', { name: '实现看板' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '已完成列' })).getByRole(
        'button',
        { name: '完善文档' },
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索任务'), {
      target: { value: 'WV-1' },
    });
    expect(
      screen.queryByRole('button', { name: '完善文档' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索任务'), {
      target: { value: '' },
    });
    fireEvent.click(
      within(screen.getByRole('group', { name: '优先级筛选' })).getByRole(
        'button',
        { name: '低' },
      ),
    );
    expect(
      screen.queryByRole('button', { name: '实现看板' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('group', { name: '优先级筛选' })).getByRole(
        'button',
        { name: '全部' },
      ),
    );
    fireEvent.change(screen.getByLabelText('负责人筛选'), {
      target: { value: 'mine' },
    });
    expect(
      screen.getByRole('button', { name: '实现看板' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '完善文档' }),
    ).not.toBeInTheDocument();
  });

  it('creates a task in the chosen column and refreshes persisted data', async () => {
    let saved: Task | null = null;
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/members')) return Response.json(members);
      if (options?.method === 'POST') {
        expect(JSON.parse(options.body as string)).toMatchObject({
          title: '验证移动',
          status: 'in_progress',
          priority: 'normal',
          assigneeId: null,
        });
        saved = {
          ...task,
          title: '验证移动',
          status: 'in_progress',
          priority: 'normal',
          assigneeId: null,
          assigneeName: null,
        };
        return Response.json(saved, { status: 201 });
      }
      if (String(url).endsWith('/history')) return Response.json([]);
      return Response.json(saved ? [saved] : []);
    });
    vi.stubGlobal('fetch', fetchMock);
    board();
    fireEvent.click(
      await screen.findByRole('button', { name: '在进行中创建任务' }),
    );
    expect(screen.getByLabelText('状态', { exact: true })).toHaveValue(
      'in_progress',
    );
    fireEvent.change(screen.getByLabelText('任务标题'), {
      target: { value: '验证移动' },
    });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: '创建任务',
      }),
    );
    expect(await screen.findByText('WV-1 已保存。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('region', { name: '进行中列' })).getByRole(
        'button',
        { name: '验证移动' },
      ),
    ).toBeInTheDocument();
  });

  it('edits status and priority with base-version checks and displays history', async () => {
    let current = task;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, options) => {
        if (String(url).endsWith('/members')) return Response.json(members);
        if (String(url).endsWith('/history'))
          return Response.json([
            {
              operationId: task.id,
              version: 1,
              kind: 'create',
              actorName: '林',
              createdAt: task.updatedAt,
              proposalId: null,
              before: null,
              after: task,
            },
          ]);
        if (options?.method === 'PUT') {
          const input = JSON.parse(options.body as string);
          expect(input).toMatchObject({
            baseVersion: 1,
            status: 'done',
            priority: 'low',
          });
          current = {
            ...task,
            status: input.status,
            priority: input.priority,
            version: 2,
          };
          return Response.json(current);
        }
        return Response.json([current]);
      }),
    );
    board();
    fireEvent.click(await screen.findByRole('button', { name: task.title }));
    expect(await screen.findByText('创建任务 · v1')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('状态', { exact: true }), {
      target: { value: 'done' },
    });
    fireEvent.change(screen.getByLabelText('优先级', { exact: true }), {
      target: { value: 'low' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }));
    await screen.findByText('WV-1 已保存。');
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('region', { name: '已完成列' })).getByRole(
        'button',
        { name: task.title },
      ),
    ).toBeInTheDocument();
  });

  it('preserves a draft on conflict and allows canceling discard', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/members')) return Response.json(members);
      if (String(url).endsWith('/history')) return Response.json([]);
      if (options?.method === 'PUT')
        return Response.json(
          { message: '任务已被修改，草稿已保留。' },
          { status: 409 },
        );
      return Response.json([task]);
    });
    vi.stubGlobal('fetch', fetchMock);
    board();
    fireEvent.click(await screen.findByRole('button', { name: task.title }));
    fireEvent.change(screen.getByLabelText('任务标题'), {
      target: { value: '必须保留的草稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存任务' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿已保留');
    expect(screen.getByLabelText('任务标题')).toHaveValue('必须保留的草稿');
    expect(screen.getByRole('button', { name: '保存任务' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: '取消',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('任务标题')).toHaveValue('必须保留的草稿');
    expect(
      fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT'),
    ).toHaveLength(1);
  });

  it('reports loading failure without pretending the board is empty and supports retry', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        if (fail) throw new Error('数据库暂不可用');
        return Response.json(
          String(url).endsWith('/members') ? members : [task],
        );
      }),
    );
    board();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '数据库暂不可用',
    );
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '刷新看板' }));
    expect(
      await screen.findByRole('button', { name: task.title }),
    ).toBeInTheDocument();
  });
});
