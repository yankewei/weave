import { Extension } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node } from '@tiptap/pm/model';
import { referencePath, splitReferences } from '@/lib/references';

const key = new PluginKey<DecorationSet>('referenceLinks');

/**
 * Shows DEV-n and DOC-n in a document as links without touching the stored
 * Markdown. Read-only views follow them on click; the editor needs Ctrl or ⌘
 * so placing the caret on a key does not leave the page.
 */
export function referenceLinks(workspaceId: string) {
  const decorate = (doc: Node) => {
    const decorations: Decoration[] = [];
    doc.descendants((node, position, parent) => {
      if (!node.isText || parent?.type.spec.code) return;
      if (node.marks.some((mark) => ['code', 'link'].includes(mark.type.name)))
        return;
      let offset = position;
      for (const part of splitReferences(node.text ?? '')) {
        if (typeof part === 'string') {
          offset += part.length;
          continue;
        }
        const length = part.key.length;
        decorations.push(
          Decoration.inline(offset, offset + length, {
            nodeName: 'a',
            href: referencePath(workspaceId, part.key),
            target: '_blank',
            rel: 'noreferrer',
          }),
        );
        offset += length;
      }
    });
    return DecorationSet.create(doc, decorations);
  };
  return Extension.create({
    name: 'referenceLinks',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key,
          state: {
            init: (_config, state) => decorate(state.doc),
            apply: (transaction, current) =>
              transaction.docChanged ? decorate(transaction.doc) : current,
          },
          props: {
            decorations: (state) => key.getState(state),
            handleClick: (view, _position, event) => {
              const link =
                event.target instanceof Element
                  ? event.target.closest<HTMLAnchorElement>('a[href]')
                  : null;
              if (!view.editable || !link || !(event.metaKey || event.ctrlKey))
                return false;
              window.open(link.href, '_blank', 'noreferrer');
              return true;
            },
          },
        }),
      ];
    },
  });
}
