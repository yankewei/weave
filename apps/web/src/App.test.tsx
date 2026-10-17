import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '林',
  email: 'lin@example.com',
};
const workspace = {
  id: '00000000-0000-4000-8000-000000000002',
  name: '产品团队',
};

describe('authentication and workspace shell', () => {
  it('shows login for an anonymous session and opens the actual workspace after login', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (url === '/api/auth/session')
        return Response.json({ message: '请先登录。' }, { status: 401 });
      if (url === '/api/auth/login') {
        expect(JSON.parse(options!.body as string)).toEqual({
          email: 'lin@example.com',
          password: 'long-password-test',
        });
        expect(options!.headers).toMatchObject({ 'X-Weave-Request': '1' });
        return Response.json(user);
      }
      if (url === '/api/workspaces') return Response.json([workspace]);
      if (url === `/api/workspaces/${workspace.id}/projects`)
        return Response.json([]);
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: '欢迎回来' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /与 AI 一起，\s*把想法推进成项目。/,
      }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: 'lin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'long-password-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(
      await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/workspaces/${workspace.id}`),
    );
    expect(
      screen.getByRole('option', { name: '产品团队' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('想做的事')).toBeEnabled(),
    );
    expect(screen.queryByText('这个页面不存在。')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        '描述要做的事。这会创建一个项目，并让 AI 拆出待确认的任务。确认后才写入看板。',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('registers a user with a named workspace', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (url === '/api/auth/session')
        return Response.json({}, { status: 401 });
      if (url === '/api/auth/register') {
        expect(JSON.parse(options!.body as string)).toEqual({
          name: '林',
          workspaceName: '产品团队',
          email: 'lin@example.com',
          password: 'long-password-test',
        });
        return Response.json(user, { status: 201 });
      }
      if (url === '/api/workspaces') return Response.json([workspace]);
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: '第一次使用？创建账号' }),
    );
    fireEvent.change(screen.getByLabelText('你的名字'), {
      target: { value: '林' },
    });
    fireEvent.change(screen.getByLabelText('工作空间名称'), {
      target: { value: '产品团队' },
    });
    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: 'lin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'long-password-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建账号与工作空间' }));
    expect(
      await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/workspaces/${workspace.id}`),
    );
  });

  it('restores a server session and logs out through the API', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/auth/session') return Response.json(user);
      if (url === '/api/workspaces') return Response.json([workspace]);
      if (url === '/api/auth/logout')
        return new Response(null, { status: 204 });
      return Response.json([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: '退出登录',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: '欢迎回来' }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows connection errors and allows retrying session discovery', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(Response.json({}, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接服务');
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole('heading', { name: '欢迎回来' }),
    ).toBeInTheDocument();
  });

  it('rejects a successful session response with an invalid payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接服务');
  });
  it('creates projects and documents through shadcn dialogs', async () => {
    const project = {
      id: '00000000-0000-4000-8000-000000000003',
      workspaceId: workspace.id,
      name: '产品改进',
    };
    const document = {
      id: '00000000-0000-4000-8000-000000000004',
      workspaceId: workspace.id,
      projectId: project.id,
      title: '需求文档',
      body: '',
      version: 1,
      updatedAt: '2026-10-16T12:00:00Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, options) => {
        if (url === '/api/auth/session') return Response.json(user);
        if (url === '/api/workspaces') return Response.json([workspace]);
        if (url === `/api/workspaces/${workspace.id}/projects`)
          return Response.json(options?.method === 'POST' ? project : []);
        if (url === `/api/projects/${project.id}/documents`)
          return Response.json(options?.method === 'POST' ? document : []);
        if (url === `/api/documents/${document.id}`)
          return Response.json(document);
        if (url === `/api/documents/${document.id}/revisions`)
          return Response.json([]);
        if (url === `/api/projects/${project.id}/conversation`)
          return Response.json({ conversation: null });
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    render(<App />);
    await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' });
    const createProjectButton = screen.getByRole('button', {
      name: '新建项目',
    });
    await waitFor(() => expect(createProjectButton).toBeEnabled());
    fireEvent.click(createProjectButton);
    const projectDialog = await screen.findByRole('dialog', {
      name: '新建项目',
    });
    fireEvent.change(within(projectDialog).getByLabelText('项目名称'), {
      target: { value: project.name },
    });
    fireEvent.click(
      within(projectDialog).getByRole('button', { name: '创建项目' }),
    );
    await screen.findByRole('heading', { name: '与 AI 一起推进这个项目。' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: '新建文档' }));
    const documentDialog = await screen.findByRole('dialog', {
      name: '新建文档',
    });
    fireEvent.change(within(documentDialog).getByLabelText('文档标题'), {
      target: { value: document.title },
    });
    fireEvent.click(
      within(documentDialog).getByRole('button', { name: '创建文档' }),
    );
    expect(
      await screen.findByRole('heading', { name: '需求文档' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('文档正文')).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/workspaces/${workspace.id}/projects/${project.id}/documents/${document.id}`,
      ),
    );
  });

  it('opens a document and the task board from their URLs', async () => {
    const project = {
      id: '00000000-0000-4000-8000-000000000003',
      workspaceId: workspace.id,
      name: '产品改进',
    };
    const document = {
      id: '00000000-0000-4000-8000-000000000004',
      workspaceId: workspace.id,
      projectId: project.id,
      title: '需求文档',
      body: '正文',
      version: 1,
      updatedAt: '2026-10-16T12:00:00Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session') return Response.json(user);
        if (url === '/api/workspaces') return Response.json([workspace]);
        if (url === `/api/workspaces/${workspace.id}/projects`)
          return Response.json([project]);
        if (url === `/api/projects/${project.id}/documents`)
          return Response.json([document]);
        if (url === `/api/documents/${document.id}`)
          return Response.json(document);
        if (url === `/api/documents/${document.id}/revisions`)
          return Response.json([]);
        if (url === `/api/projects/${project.id}/tasks`)
          return Response.json([]);
        if (url === `/api/projects/${project.id}/members`)
          return Response.json([]);
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    window.history.replaceState(
      null,
      '',
      `/workspaces/${workspace.id}/projects/${project.id}/documents/${document.id}`,
    );
    const { unmount } = render(<App />);
    expect(
      await screen.findByRole('heading', { name: '需求文档' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('文档正文')).toHaveValue('正文');
    unmount();

    window.history.replaceState(
      null,
      '',
      `/workspaces/${workspace.id}/projects/${project.id}/board`,
    );
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: '任务看板' }),
    ).toBeInTheDocument();
    expect(screen.getByText('产品改进 / 执行与交付')).toBeInTheDocument();
  });

  it('shows the login screen for a deep link and keeps that URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session')
          return Response.json({ message: '请先登录。' }, { status: 401 });
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    const path = `/workspaces/${workspace.id}/projects/00000000-0000-4000-8000-000000000003/board`;
    window.history.replaceState(null, '', path);
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: '欢迎回来' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
  });

  it('opens the first project from a workspace URL', async () => {
    const project = {
      id: '00000000-0000-4000-8000-000000000003',
      workspaceId: workspace.id,
      name: '产品改进',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session') return Response.json(user);
        if (url === '/api/workspaces') return Response.json([workspace]);
        if (url === `/api/workspaces/${workspace.id}/projects`)
          return Response.json([project]);
        if (url === `/api/projects/${project.id}/documents`)
          return Response.json([]);
        if (url === `/api/projects/${project.id}/conversation`)
          return Response.json({ conversation: null });
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    window.history.replaceState(null, '', `/workspaces/${workspace.id}`);
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: '与 AI 一起推进这个项目。' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/workspaces/${workspace.id}/projects/${project.id}`,
      ),
    );
    expect(screen.getByLabelText('想做的事')).toBeEnabled();
    expect(
      screen.getByRole('heading', { name: '给注册加上失败提示' }),
    ).toBeInTheDocument();
  });

  it('creates a project from the first idea and asks AI to split it', async () => {
    const idea = '给注册加上失败提示，并写清怎样算做完。';
    const project = {
      id: '00000000-0000-4000-8000-000000000003',
      workspaceId: workspace.id,
      name: '给注册加上失败提示，并写清怎样算做完',
    };
    const finished = {
      conversation: {
        id: '00000000-0000-4000-8000-000000000012',
        workspaceId: workspace.id,
        projectId: project.id,
        messages: [
          {
            id: '00000000-0000-4000-8000-000000000014',
            authorType: 'user',
            authorName: '林',
            body: idea,
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
          id: '00000000-0000-4000-8000-000000000011',
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
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, options) => {
        if (url === '/api/auth/session') return Response.json(user);
        if (url === '/api/workspaces') return Response.json([workspace]);
        if (url === `/api/workspaces/${workspace.id}/projects`) {
          if (options?.method === 'POST') {
            expect(JSON.parse(options.body as string)).toEqual({
              name: project.name,
            });
            return Response.json(project);
          }
          return Response.json([]);
        }
        if (url === `/api/projects/${project.id}/documents`)
          return Response.json([]);
        if (
          url === `/api/projects/${project.id}/conversation` &&
          !options?.method
        )
          return Response.json({ conversation: null });
        if (url === `/api/projects/${project.id}/conversation/messages`) {
          expect(JSON.parse(options!.body as string)).toEqual({ body: idea });
          return new Response(
            `event: reply\ndata: ${JSON.stringify({ reply: '可以拆成一项。' })}\n\nevent: done\ndata: ${JSON.stringify(finished)}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    render(<App />);
    await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' });
    await waitFor(() =>
      expect(screen.getByLabelText('想做的事')).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText('想做的事'), {
      target: { value: idea },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送给 AI' }));
    expect(await screen.findByText('可以拆成一项。')).toBeInTheDocument();
    expect(screen.getByText('显示注册失败原因')).toBeInTheDocument();
    expect(screen.getByLabelText('想做的事')).toBeDisabled();
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/workspaces/${workspace.id}/projects/${project.id}`,
      ),
    );
  });

  it('invites and removes a workspace member from settings', async () => {
    const membersUrl = `/api/workspaces/${workspace.id}/members`;
    const invited = {
      id: '00000000-0000-4000-8000-000000000009',
      name: '其他用户',
      email: 'other@example.com',
      role: 'member' as const,
    };
    let members: Array<{
      id: string;
      name: string;
      email: string;
      role: 'admin' | 'member';
    }> = [
      {
        id: user.id,
        name: user.name,
        email: user.email,
        role: 'admin',
      },
    ];
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (url === '/api/auth/session') return Response.json(user);
      if (url === '/api/workspaces') return Response.json([workspace]);
      if (url === `/api/workspaces/${workspace.id}/projects`)
        return Response.json([]);
      if (url === membersUrl && options?.method === 'POST') {
        expect(JSON.parse(options.body as string)).toEqual({
          email: invited.email,
        });
        expect(options.headers).toMatchObject({ 'X-Weave-Request': '1' });
        members = [...members, invited];
        return Response.json(invited, { status: 201 });
      }
      if (url === `${membersUrl}/${invited.id}` && options?.method === 'DELETE')
        return Response.json({
          unassignedTaskCount: 1,
          rejectedProposalCount: 1,
        });
      if (url === membersUrl) return Response.json(members);
      if (url === `/api/workspaces/${workspace.id}/storage`)
        return Response.json({ storage: null, shortcut: null });
      if (url === '/api/account/storage')
        return Response.json({ storage: null });
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
      membersUrl,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    const page = await screen.findByRole('region', { name: '工作空间设置' });
    expect(window.location.pathname).toBe(
      `/workspaces/${workspace.id}/settings`,
    );
    expect(
      within(page).getByRole('heading', { name: workspace.name }),
    ).toBeInTheDocument();
    expect(
      within(page).getByRole('heading', { name: user.name }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '我的存储' }),
    ).not.toBeInTheDocument();
    const memberList = await within(page).findByRole('list', {
      name: '工作空间成员',
    });
    expect(within(memberList).getByText(user.name)).toBeInTheDocument();
    expect(within(memberList).getByText(user.email)).toBeInTheDocument();
    expect(within(memberList).getByText('管理员')).toBeInTheDocument();
    expect(within(page).getByLabelText('邮箱')).toBeEnabled();
    expect(
      within(page).getByText('你是唯一的管理员，不能退出。'),
    ).toBeInTheDocument();
    fireEvent.change(within(page).getByLabelText('邮箱'), {
      target: { value: invited.email },
    });
    fireEvent.click(within(page).getByRole('button', { name: '邀请' }));
    const list = await within(page).findByRole('list', {
      name: '工作空间成员',
    });
    expect(await within(list).findByText(invited.name)).toBeInTheDocument();
    expect(
      within(page).getByText(`已邀请${invited.name}。`),
    ).toBeInTheDocument();
    expect(within(list).getByText('成员')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: '移除' }));
    const confirmation = await screen.findByRole('alertdialog');
    expect(
      within(confirmation).getByText(/负责的任务会改为未分配/),
    ).toBeInTheDocument();
    members = members.filter((member) => member.id !== invited.id);
    fireEvent.click(within(confirmation).getByRole('button', { name: '移除' }));
    expect(
      await within(page).findByText(
        `已移除${invited.name}，1 项任务已改为未分配，1 份待确认提案已拒绝。`,
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(page).queryByText(invited.name)).not.toBeInTheDocument(),
    );
    expect(
      within(page).getByText('你是唯一的管理员，不能退出。'),
    ).toBeInTheDocument();
  });

  it('saves object storage for the current workspace', async () => {
    const storageUrl = `/api/workspaces/${workspace.id}/storage`;
    const saved = {
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'weave-images',
      prefix: 'images',
      accessKeyId: 'access-key',
    };
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (url === '/api/auth/session') return Response.json(user);
      if (url === '/api/workspaces') return Response.json([workspace]);
      if (url === `/api/workspaces/${workspace.id}/projects`)
        return Response.json([]);
      if (url === `/api/workspaces/${workspace.id}/members`)
        return Response.json([{ ...user, role: 'admin' }]);
      if (url === storageUrl && options?.method === 'PUT') {
        expect(JSON.parse(options.body as string)).toEqual({
          ...saved,
          secretAccessKey: 'secret-key',
        });
        expect(options.headers).toMatchObject({ 'X-Weave-Request': '1' });
        return Response.json({ storage: saved, shortcut: null });
      }
      if (url === storageUrl)
        return Response.json({ storage: null, shortcut: null });
      if (url === '/api/account/storage')
        return Response.json({ storage: null });
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
      storageUrl,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    const page = await screen.findByRole('region', { name: '工作空间设置' });
    const team = within(page).getByRole('region', { name: workspace.name });
    expect(await within(team).findByLabelText('服务地址')).toBeInTheDocument();
    fireEvent.change(within(team).getByLabelText('服务地址'), {
      target: { value: saved.endpoint },
    });
    fireEvent.change(within(team).getByLabelText('区域'), {
      target: { value: saved.region },
    });
    fireEvent.change(within(team).getByLabelText('桶'), {
      target: { value: saved.bucket },
    });
    fireEvent.change(within(team).getByLabelText('目录'), {
      target: { value: saved.prefix },
    });
    fireEvent.change(within(team).getByLabelText('访问密钥编号'), {
      target: { value: saved.accessKeyId },
    });
    fireEvent.change(within(team).getByLabelText('访问密钥'), {
      target: { value: 'secret-key' },
    });
    fireEvent.click(
      within(team).getByRole('button', { name: `保存${workspace.name}的存储` }),
    );
    expect(
      await within(team).findByText(`已保存${workspace.name}的存储。`),
    ).toBeInTheDocument();
    expect(within(team).getByLabelText('访问密钥')).toHaveValue('');
  });

  it('shows the admin-only storage notice to a non-admin member', async () => {
    const storageUrl = `/api/workspaces/${workspace.id}/storage`;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/auth/session') return Response.json(user);
      if (url === '/api/workspaces') return Response.json([workspace]);
      if (url === `/api/workspaces/${workspace.id}/projects`)
        return Response.json([]);
      if (url === `/api/workspaces/${workspace.id}/members`)
        return Response.json([{ ...user, role: 'member' }]);
      if (url === '/api/account/storage')
        return Response.json({ storage: null });
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' });
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    const page = await screen.findByRole('region', { name: '工作空间设置' });
    const team = within(page).getByRole('region', { name: workspace.name });
    expect(
      await within(team).findByText('只有管理员可以查看和配置工作空间存储。'),
    ).toBeInTheDocument();
    expect(within(team).queryByLabelText('服务地址')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
      storageUrl,
    );
  });

  it('links the workspace to the signed-in admin’s storage', async () => {
    const accountUrl = '/api/account/storage';
    const storageUrl = `/api/workspaces/${workspace.id}/storage`;
    const shortcutUrl = `${storageUrl}/shortcut`;
    const saved = {
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'weave-images',
      prefix: 'images',
      accessKeyId: 'access-key',
    };
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (url === '/api/auth/session') return Response.json(user);
      if (url === '/api/workspaces') return Response.json([workspace]);
      if (url === `/api/workspaces/${workspace.id}/projects`)
        return Response.json([]);
      if (url === `/api/workspaces/${workspace.id}/members`)
        return Response.json([{ ...user, role: 'admin' }]);
      if (url === accountUrl && options?.method === 'PUT') {
        expect(JSON.parse(options.body as string)).toEqual({
          ...saved,
          secretAccessKey: 'secret-key',
        });
        return Response.json({ storage: saved });
      }
      if (url === accountUrl) return Response.json({ storage: null });
      if (url === shortcutUrl && options?.method === 'PUT') {
        expect(options.headers).toMatchObject({ 'X-Weave-Request': '1' });
        return Response.json({
          storage: saved,
          shortcut: { userId: user.id, name: user.name },
        });
      }
      if (url === storageUrl)
        return Response.json({ storage: null, shortcut: null });
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByRole('heading', { name: '从一个想法，与 AI 开始。' });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain(
      accountUrl,
    );
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    const page = await screen.findByRole('region', { name: '工作空间设置' });
    const account = within(page).getByRole('region', { name: user.name });
    const team = within(page).getByRole('region', { name: workspace.name });
    expect(
      await within(account).findByLabelText('服务地址'),
    ).toBeInTheDocument();
    fireEvent.change(within(account).getByLabelText('服务地址'), {
      target: { value: saved.endpoint },
    });
    fireEvent.change(within(account).getByLabelText('区域'), {
      target: { value: saved.region },
    });
    fireEvent.change(within(account).getByLabelText('桶'), {
      target: { value: saved.bucket },
    });
    fireEvent.change(within(account).getByLabelText('目录'), {
      target: { value: saved.prefix },
    });
    fireEvent.change(within(account).getByLabelText('访问密钥编号'), {
      target: { value: saved.accessKeyId },
    });
    fireEvent.change(within(account).getByLabelText('访问密钥'), {
      target: { value: 'secret-key' },
    });
    fireEvent.click(
      within(account).getByRole('button', {
        name: `保存${user.name}的个人存储`,
      }),
    );
    expect(
      await within(account).findByText(`已保存${user.name}的个人存储。`),
    ).toBeInTheDocument();
    fireEvent.click(
      within(team).getByRole('button', {
        name: `让${workspace.name}使用${user.name}的个人存储`,
      }),
    );
    expect(
      await within(team).findByText(
        `${workspace.name}正在使用${user.name}的个人存储。`,
      ),
    ).toBeInTheDocument();
    expect(
      within(team).getByRole('button', {
        name: `${workspace.name}正在使用${user.name}的个人存储`,
      }),
    ).toBeDisabled();
  });

  it('stays on workspace settings when the workspace already has a project', async () => {
    const project = {
      id: '00000000-0000-4000-8000-000000000003',
      workspaceId: workspace.id,
      name: '产品改进',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session') return Response.json(user);
        if (url === '/api/workspaces') return Response.json([workspace]);
        if (url === `/api/workspaces/${workspace.id}/projects`)
          return Response.json([project]);
        if (url === `/api/projects/${project.id}/documents`)
          return Response.json([]);
        if (url === `/api/projects/${project.id}/conversation`)
          return Response.json({ conversation: null });
        if (url === `/api/workspaces/${workspace.id}/members`)
          return Response.json([]);
        if (url === `/api/workspaces/${workspace.id}/storage`)
          return Response.json({ storage: null, shortcut: null });
        if (url === '/api/account/storage')
          return Response.json({ storage: null });
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    render(<App />);
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/workspaces/${workspace.id}/projects/${project.id}`,
      ),
    );
    fireEvent.click(screen.getAllByRole('button', { name: '设置' })[0]!);
    expect(
      await screen.findByRole('heading', { name: '设置' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.location.pathname).toBe(
        `/workspaces/${workspace.id}/settings`,
      ),
    );
  });

  it('shows a missing page for an unknown URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session') return Response.json(user);
        if (url === '/api/workspaces') return Response.json([workspace]);
        throw new Error(`Unexpected request: ${String(url)}`);
      }),
    );
    window.history.replaceState(null, '', '/missing');
    render(<App />);
    expect(await screen.findByText('这个页面不存在。')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/missing');
  });
});
