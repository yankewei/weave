'use client';

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from '@tiptap/react';
import { Placeholder } from '@tiptap/extensions';
import {
  BetweenHorizontalEndIcon,
  BetweenHorizontalStartIcon,
  BetweenVerticalEndIcon,
  BetweenVerticalStartIcon,
  BoldIcon,
  CodeIcon,
  Grid2x2XIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  MinusIcon,
  QuoteIcon,
  Redo2Icon,
  SquareCodeIcon,
  StrikethroughIcon,
  TableColumnsSplitIcon,
  TableIcon,
  TableRowsSplitIcon,
  Undo2Icon,
} from 'lucide-react';
import { imageUploadTypes } from '@/lib/contracts';
import { documentExtensions } from '@/lib/document-extensions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export type InsertImage = (image: { src: string; alt: string }) => void;

/** Renders a stored Markdown body the same way the editor shows it. */
export function DocumentContent({ markdown }: { markdown: string }) {
  const editor = useEditor(
    {
      extensions: documentExtensions,
      content: markdown,
      contentType: 'markdown',
      editable: false,
      immediatelyRender: false,
      editorProps: { attributes: { class: 'document-content' } },
    },
    [markdown],
  );
  return <EditorContent editor={editor} />;
}

export function RichTextEditor({
  labelId,
  markdown,
  disabled,
  uploading,
  onChange,
  onLoad,
  onImages,
}: {
  labelId: string;
  markdown: string;
  disabled: boolean;
  uploading: boolean;
  onChange: (markdown: string) => void;
  /** Reports the body as the editor will save it, before any user edit. */
  onLoad: (markdown: string) => void;
  onImages: (files: File[], insert: InsertImage) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // ProseMirror keeps the handlers it was created with, so they read the latest props here.
  const handlers = useRef({ onChange, onLoad, onImages });
  const instance = useRef<Editor | null>(null);
  useEffect(() => {
    handlers.current = { onChange, onLoad, onImages };
  });

  const editor = useEditor({
    extensions: [
      ...documentExtensions,
      Placeholder.configure({
        placeholder: '写下需求、方案或一个待讨论的问题…',
      }),
    ],
    content: markdown,
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'document-content min-h-96 px-6 py-5 outline-none sm:px-8',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-labelledby': labelId,
      },
      handlePaste: (_view, event) => pasteImages(event.clipboardData?.files),
      handleDrop: (_view, event) => pasteImages(event.dataTransfer?.files),
    },
    onCreate: ({ editor }) => {
      instance.current = editor;
      handlers.current.onLoad(editor.getMarkdown());
    },
    onUpdate: ({ editor }) => handlers.current.onChange(editor.getMarkdown()),
  });

  function insertImages(files: File[]) {
    const current = instance.current;
    if (!current) return;
    handlers.current.onImages(files, (image) =>
      current.chain().focus().setImage(image).run(),
    );
  }

  function pasteImages(list: FileList | undefined) {
    const files = Array.from(list ?? []);
    if (!files.some((file) => file.type.startsWith('image/'))) return false;
    insertImages(files);
    return true;
  }

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  return (
    <div className="flex min-w-0 flex-col">
      {editor ? (
        <Toolbar
          editor={editor}
          disabled={disabled}
          uploading={uploading}
          onPickImage={() => fileRef.current?.click()}
        />
      ) : (
        <div className="h-11 border-b" />
      )}
      <Input
        ref={fileRef}
        type="file"
        accept={imageUploadTypes.join(',')}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          insertImages(files);
        }}
      />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({
  editor,
  disabled,
  uploading,
  onPickImage,
}: {
  editor: Editor;
  disabled: boolean;
  uploading: boolean;
  onPickImage: () => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      h1: editor.isActive('heading', { level: 1 }),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      link: editor.isActive('link'),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      taskList: editor.isActive('taskList'),
      blockquote: editor.isActive('blockquote'),
      codeBlock: editor.isActive('codeBlock'),
      table: editor.isActive('table'),
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  return (
    <div className="sticky top-0 z-10 flex flex-col rounded-t-lg border-b bg-background">
      <div
        role="toolbar"
        aria-label="正文格式"
        aria-orientation="horizontal"
        className="flex flex-wrap items-center gap-1 px-4 py-2 sm:px-6"
      >
        <ToolbarButton
          label="撤销"
          disabled={disabled || !state.canUndo}
          onClick={() => chain().undo().run()}
        >
          <Undo2Icon />
        </ToolbarButton>
        <ToolbarButton
          label="重做"
          disabled={disabled || !state.canRedo}
          onClick={() => chain().redo().run()}
        >
          <Redo2Icon />
        </ToolbarButton>
        <Separator orientation="vertical" className="mx-1 h-5" />
        {([1, 2, 3] as const).map((level) => (
          <ToolbarToggle
            key={level}
            label={`${level} 级标题`}
            pressed={state[`h${level}`]}
            disabled={disabled}
            onClick={() => chain().toggleHeading({ level }).run()}
          >
            {level === 1 ? (
              <Heading1Icon />
            ) : level === 2 ? (
              <Heading2Icon />
            ) : (
              <Heading3Icon />
            )}
          </ToolbarToggle>
        ))}
        <Separator orientation="vertical" className="mx-1 h-5" />
        <ToolbarToggle
          label="加粗"
          pressed={state.bold}
          disabled={disabled}
          onClick={() => chain().toggleBold().run()}
        >
          <BoldIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="斜体"
          pressed={state.italic}
          disabled={disabled}
          onClick={() => chain().toggleItalic().run()}
        >
          <ItalicIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="删除线"
          pressed={state.strike}
          disabled={disabled}
          onClick={() => chain().toggleStrike().run()}
        >
          <StrikethroughIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="行内代码"
          pressed={state.code}
          disabled={disabled}
          onClick={() => chain().toggleCode().run()}
        >
          <CodeIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="链接"
          pressed={state.link}
          disabled={disabled}
          onClick={() => setLinkOpen(true)}
        >
          <LinkIcon />
        </ToolbarToggle>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <ToolbarToggle
          label="无序列表"
          pressed={state.bulletList}
          disabled={disabled}
          onClick={() => chain().toggleBulletList().run()}
        >
          <ListIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="有序列表"
          pressed={state.orderedList}
          disabled={disabled}
          onClick={() => chain().toggleOrderedList().run()}
        >
          <ListOrderedIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="待办列表"
          pressed={state.taskList}
          disabled={disabled}
          onClick={() => chain().toggleTaskList().run()}
        >
          <ListTodoIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="引用"
          pressed={state.blockquote}
          disabled={disabled}
          onClick={() => chain().toggleBlockquote().run()}
        >
          <QuoteIcon />
        </ToolbarToggle>
        <ToolbarToggle
          label="代码块"
          pressed={state.codeBlock}
          disabled={disabled}
          onClick={() => chain().toggleCodeBlock().run()}
        >
          <SquareCodeIcon />
        </ToolbarToggle>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <ToolbarButton
          label="分隔线"
          disabled={disabled}
          onClick={() => chain().setHorizontalRule().run()}
        >
          <MinusIcon />
        </ToolbarButton>
        <ToolbarButton
          label={uploading ? '正在上传图片…' : '插入图片'}
          disabled={disabled || uploading}
          onClick={onPickImage}
        >
          {uploading ? <Spinner /> : <ImageIcon />}
        </ToolbarButton>
        <ToolbarButton
          label={state.table ? '光标已在表格中' : '插入表格'}
          disabled={disabled || state.table}
          onClick={() =>
            chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        >
          <TableIcon />
        </ToolbarButton>
      </div>
      {/* Table edits only make sense inside a table, so they get their own labelled row there. */}
      {state.table && (
        <>
          <Separator />
          <div
            role="toolbar"
            aria-label="表格操作"
            aria-orientation="horizontal"
            className="flex flex-wrap items-center gap-1 px-4 py-1.5 sm:px-6"
          >
            <span className="mr-1 text-xs text-muted-foreground">表格</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => chain().addRowBefore().run()}
            >
              <BetweenHorizontalStartIcon data-icon="inline-start" />
              上方插入行
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => chain().addRowAfter().run()}
            >
              <BetweenHorizontalEndIcon data-icon="inline-start" />
              下方插入行
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => chain().addColumnBefore().run()}
            >
              <BetweenVerticalStartIcon data-icon="inline-start" />
              左侧插入列
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => chain().addColumnAfter().run()}
            >
              <BetweenVerticalEndIcon data-icon="inline-start" />
              右侧插入列
            </Button>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => chain().deleteRow().run()}
            >
              <TableRowsSplitIcon data-icon="inline-start" />
              删除行
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => chain().deleteColumn().run()}
            >
              <TableColumnsSplitIcon data-icon="inline-start" />
              删除列
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => chain().deleteTable().run()}
            >
              <Grid2x2XIcon data-icon="inline-start" />
              删除表格
            </Button>
          </div>
        </>
      )}
      <LinkDialog
        open={linkOpen}
        editorElement={editor.view.dom}
        href={editor.getAttributes('link').href ?? ''}
        onOpenChange={setLinkOpen}
        onSubmit={(href) => {
          const link = chain().extendMarkRange('link');
          (href ? link.setLink({ href }) : link.unsetLink()).run();
          setLinkOpen(false);
        }}
      />
    </div>
  );
}

function ToolbarToggle({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="sm"
            aria-label={label}
            pressed={pressed}
            disabled={disabled}
            onPressedChange={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function LinkDialog({
  open,
  editorElement,
  href,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  editorElement: HTMLElement;
  href: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (href: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Back in the text, not on the toolbar, so typing doesn't replace the linked selection. */}
      <DialogContent finalFocus={() => editorElement}>
        <DialogHeader>
          <DialogTitle>{href ? '编辑链接' : '添加链接'}</DialogTitle>
          <DialogDescription>
            作用于选中的文字；清空地址会移除链接。
          </DialogDescription>
        </DialogHeader>
        <form
          id="document-link"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            // React bubbles submit through the portal into the document form, which would save it.
            event.stopPropagation();
            const value = new FormData(event.currentTarget).get('href');
            onSubmit(String(value ?? '').trim());
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="document-link-href">链接地址</FieldLabel>
              <Input
                id="document-link-href"
                name="href"
                type="url"
                defaultValue={href}
                placeholder="https://"
                autoFocus
              />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="submit" form="document-link">
            {href ? '更新链接' : '添加链接'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
