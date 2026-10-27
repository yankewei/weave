import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

// Bodies stay Markdown so revisions, line diffs and restore keep working; the
// editor only offers nodes that survive a Markdown round trip.
export const documentExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      protocols: ['http', 'https', 'mailto'],
    },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
  TableKit.configure({ table: { resizable: false } }),
  Markdown,
];
