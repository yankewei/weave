import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Document, Revision } from '@weave/contracts';
import { DocumentEditor } from './DocumentEditor.js';

const document: Document = {
  id: '00000000-0000-4000-8000-000000000003',
  workspaceId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  title: '需求文档',
  body: '第二版内容',
  version: 2,
  updatedAt: '2026-10-16T12:00:00Z',
};
const revisions: Revision[] = [
  {
    version: 2,
    title: document.title,
    body: document.body,
    actorName: '林',
    createdAt: document.updatedAt,
    operationId: '00000000-0000-4000-8000-000000000004',
    kind: 'edit',
    restoredFromVersion: null,
  },
  {
    version: 1,
    title: document.title,
    body: '第一版内容',
    actorName: '林',
    createdAt: document.updatedAt,
    operationId: '00000000-0000-4000-8000-000000000005',
    kind: 'create',
    restoredFromVersion: null,
  },
];

describe('document editing and history', () => {
  it('shows persisted differences and saves with the loaded base version', async () => {
    const onSaved = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/revisions')) return Response.json(revisions);
      expect(options!.method).toBe('PUT');
      expect(JSON.parse(options!.body as string)).toEqual({
        title: document.title,
        body: '新的草稿',
        baseVersion: 2,
      });
      return Response.json({ ...document, body: '新的草稿', version: 3 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <DocumentEditor
        document={document}
        onSaved={onSaved}
        onDirtyChange={vi.fn()}
        onBusyChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'v1 → v2' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '版本差异' })).toHaveTextContent(
      '第一版内容',
    );
    fireEvent.change(screen.getByLabelText('文档正文'), {
      target: { value: '新的草稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ version: 3, body: '新的草稿' }),
      ),
    );
  });

  it('preserves the draft and blocks saving after a version conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith('/revisions')
          ? Response.json(revisions)
          : Response.json(
              { message: '文档已被修改。你的草稿已保留。' },
              { status: 409 },
            ),
      ),
    );
    const onSaved = vi.fn();
    render(
      <DocumentEditor
        document={document}
        onSaved={onSaved}
        onDirtyChange={vi.fn()}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('文档正文'), {
      target: { value: '不能丢失的草稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('草稿已保留');
    expect(screen.getByLabelText('文档正文')).toHaveValue('不能丢失的草稿');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('restores the selected historical version against the current version', async () => {
    const onSaved = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/revisions')) return Response.json(revisions);
      expect(String(url)).toBe(`/api/documents/${document.id}/restore`);
      expect(JSON.parse(options!.body as string)).toEqual({
        baseVersion: 2,
        revisionVersion: 1,
      });
      return Response.json({ ...document, body: '第一版内容', version: 3 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <DocumentEditor
        document={document}
        onSaved={onSaved}
        onDirtyChange={vi.fn()}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /创建文档/ }));
    fireEvent.click(screen.getByRole('button', { name: '恢复到 v1 的内容' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: '确认恢复',
      }),
    );
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ version: 3, body: '第一版内容' }),
      ),
    );
    expect(screen.getByLabelText('文档正文')).toHaveValue('第一版内容');
  });

  it('keeps unsaved text when a request fails and warns before leaving', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith('/revisions')) return Response.json(revisions);
        throw new Error('网络连接失败');
      }),
    );
    render(
      <DocumentEditor
        document={document}
        onSaved={vi.fn()}
        onDirtyChange={vi.fn()}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('文档正文'), {
      target: { value: '未保存的正文' },
    });
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接失败');
    expect(screen.getByLabelText('文档正文')).toHaveValue('未保存的正文');
  });
  it('cancels a restore without writing or losing an unsaved draft', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(revisions));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    render(
      <DocumentEditor
        document={document}
        onSaved={onSaved}
        onDirtyChange={vi.fn()}
        onBusyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('文档正文'), {
      target: { value: '需要保留的草稿' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /创建文档/ }));
    fireEvent.click(screen.getByRole('button', { name: '恢复到 v1 的内容' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('当前未保存的草稿将丢失');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('文档正文')).toHaveValue('需要保留的草稿');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
