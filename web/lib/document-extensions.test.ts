import { Editor } from '@tiptap/react';
import { afterEach, describe, expect, it } from 'vitest';
import { documentExtensions } from './document-extensions';

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

function roundTrip(markdown: string) {
  editor = new Editor({
    extensions: documentExtensions,
    content: markdown,
    contentType: 'markdown',
  });
  return editor.getMarkdown();
}

describe('document extensions', () => {
  it('keeps the Markdown the editor offers stable across a round trip', () => {
    const markdown = [
      '# 需求',
      '',
      '一段 **加粗**、*斜体*、~~删除~~、`代码` 和 [链接](https://example.com)。',
      '',
      '## 列表',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '1. 步骤一',
      '2. 步骤二',
      '',
      '- [ ] 待办',
      '- [x] 已完成',
      '',
      '> 引用',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '| 字段 | 说明 |',
      '| --- | --- |',
      '| id | 主键 |',
      '',
      '![截图](/api/uploads/abc)',
      '',
      '---',
    ].join('\n');
    const once = roundTrip(markdown);
    editor?.destroy();
    expect(roundTrip(once)).toBe(once);
    for (const fragment of [
      '# 需求',
      '**加粗**',
      '[链接](https://example.com)',
      '- [ ] 待办',
      '- [x] 已完成',
      '```ts',
      '| id',
      '![截图](/api/uploads/abc)',
    ])
      expect(once).toContain(fragment);
  });
});
