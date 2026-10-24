import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tool } from 'ai';
import { z } from 'zod';
import {
  taskPrioritySchema,
  taskStatusSchema,
  type MessageSource,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '@/lib/contracts';
import {
  taskFieldLabels,
  taskHistoryValue,
  taskPriorityLabels,
  taskStatusLabels,
} from '@/lib/task-ui';
import { transaction } from '../db';
import { project as loadProject } from './tasks';

// Read-only lookups the conversation model can call. Every call re-checks
// membership, stays inside one project and is recorded on the AI run.

const maxReadChars = 4_000;
const snippetRadius = 80;

type Lookup<T> = { result: T; summary: string; refs: MessageSource[] };

function pattern(query: string) {
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

function snippets(text: string, query: string, limit = 3) {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: string[] = [];
  let from = 0;
  while (found.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const start = Math.max(0, at - snippetRadius);
    const end = Math.min(text.length, at + needle.length + snippetRadius);
    found.push(
      `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    );
    from = end;
  }
  return found;
}

type Section = { heading: string; level: number; start: number; end: number };

// Markdown headings outside fenced code split a document into sections.
export function documentSections(body: string): Section[] {
  const sections: Section[] = [];
  let fenced = false;
  let offset = 0;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading)
      sections.push({
        heading: heading[2]!,
        level: heading[1]!.length,
        start: offset,
        end: body.length,
      });
    offset += line.length + 1;
  }
  for (const [index, section] of sections.entries()) {
    const next = sections
      .slice(index + 1)
      .find((candidate) => candidate.level <= section.level);
    if (next) section.end = next.start;
  }
  return sections;
}

export const searchTasksInput = z.object({
  query: z
    .string()
    .trim()
    .max(100)
    .nullable()
    .describe(
      '关键词，匹配标题、描述、验收标准、评论或 WV-编号；不按关键词筛选时为 null',
    ),
  status: taskStatusSchema.nullable(),
  priority: taskPrioritySchema.nullable(),
  assignee: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .describe(
      '"me" 表示当前用户，"unassigned" 表示未分配，其他值按负责人姓名匹配',
    ),
});

export async function searchTasks(
  client: PoolClient,
  userId: string,
  projectId: string,
  input: z.infer<typeof searchTasksInput>,
): Promise<Lookup<unknown>> {
  const query = input.query || null;
  const number = query ? /^WV-?(\d+)$/i.exec(query)?.[1] : undefined;
  const text = query && !number ? pattern(query) : null;
  const assignee = input.assignee || null;
  const assigneeMode =
    assignee === 'me' || assignee === 'unassigned'
      ? assignee
      : assignee
        ? 'name'
        : null;
  const rows = await client.query<{
    id: string;
    number: number;
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    assigneeName: string | null;
    description: string;
    acceptanceCriteria: string;
  }>(
    `SELECT t.id, t.number, t.title, t.status, t.priority, u.name AS "assigneeName",
       t.description, t.acceptance_criteria AS "acceptanceCriteria"
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.project_id = $1
       AND ($2::int IS NULL OR t.number = $2)
       AND ($3::text IS NULL OR t.title ILIKE $3 OR t.description ILIKE $3
         OR t.acceptance_criteria ILIKE $3
         OR EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.body ILIKE $3))
       AND ($4::text IS NULL OR t.status = $4)
       AND ($5::text IS NULL OR t.priority = $5)
       AND ($6::text IS NULL
         OR ($6 = 'me' AND t.assignee_id = $7)
         OR ($6 = 'unassigned' AND t.assignee_id IS NULL)
         OR ($6 = 'name' AND u.name ILIKE $8))
     ORDER BY ($3::text IS NOT NULL AND t.title ILIKE $3) DESC, t.updated_at DESC, t.number
     LIMIT 20`,
    [
      projectId,
      number ? Number(number) : null,
      text,
      input.status,
      input.priority,
      assigneeMode,
      userId,
      assigneeMode === 'name' ? pattern(assignee!) : null,
    ],
  );
  const filters = [
    query && `「${query}」`,
    input.status && taskStatusLabels[input.status],
    input.priority && `${taskPriorityLabels[input.priority]}优先级`,
    assignee &&
      (assignee === 'me'
        ? '我负责的'
        : assignee === 'unassigned'
          ? '未分配'
          : `${assignee}负责的`),
  ].filter(Boolean);
  return {
    summary: `搜索任务${filters.length ? ` ${filters.join(' · ')}` : ''}，找到 ${rows.rows.length} 个`,
    refs: rows.rows.map((task) => ({
      type: 'task',
      id: task.id,
      number: task.number,
      title: task.title,
    })),
    result: rows.rows.map((task) => {
      const detail = `${task.description}\n${task.acceptanceCriteria}`;
      const matched = query && !number ? snippets(detail, query, 1)[0] : null;
      return {
        number: `WV-${task.number}`,
        title: task.title,
        status: taskStatusLabels[task.status],
        priority: taskPriorityLabels[task.priority],
        assignee: task.assigneeName ?? '未分配',
        excerpt: matched ?? task.description.slice(0, 160),
      };
    }),
  };
}

export const getTaskInput = z.object({
  number: z.number().int().positive().describe('任务编号，WV-14 填 14'),
});

const trackedFields = Object.keys(taskFieldLabels) as Array<
  keyof typeof taskFieldLabels
>;

export async function getTask(
  client: PoolClient,
  projectId: string,
  input: z.infer<typeof getTaskInput>,
): Promise<Lookup<unknown>> {
  const found = await client.query<{
    id: string;
    number: number;
    title: string;
    description: string;
    acceptanceCriteria: string;
    status: TaskStatus;
    priority: TaskPriority;
    assigneeName: string | null;
    updatedAt: Date;
  }>(
    `SELECT t.id, t.number, t.title, t.description, t.acceptance_criteria AS "acceptanceCriteria",
       t.status, t.priority, u.name AS "assigneeName", t.updated_at AS "updatedAt"
     FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.project_id = $1 AND t.number = $2`,
    [projectId, input.number],
  );
  const task = found.rows[0];
  if (!task)
    return {
      summary: `查看 WV-${input.number}，没有这个任务`,
      refs: [],
      result: { error: `项目里没有 WV-${input.number}。` },
    };
  const comments = await client.query<{
    authorName: string;
    body: string;
    createdAt: Date;
    reply: boolean;
  }>(
    `SELECT * FROM (
       SELECT u.name AS "authorName", c.body, c.created_at AS "createdAt", c.parent_id IS NOT NULL AS reply
       FROM task_comments c JOIN users u ON u.id = c.author_id
       WHERE c.task_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 20
     ) recent ORDER BY "createdAt"`,
    [task.id],
  );
  const events = await client.query<{
    kind: 'create' | 'edit' | 'move';
    actorName: string;
    createdAt: Date;
    before: Task | null;
    after: Task;
    fromProposal: boolean;
  }>(
    `SELECT e.kind, u.name AS "actorName", e.created_at AS "createdAt",
       e.before_state AS before, e.after_state AS after, e.proposal_id IS NOT NULL AS "fromProposal"
     FROM task_events e JOIN users u ON u.id = e.initiator_id
     WHERE e.task_id = $1 ORDER BY e.version DESC LIMIT 10`,
    [task.id],
  );
  return {
    summary: `查看 WV-${task.number} ${task.title}`,
    refs: [
      { type: 'task', id: task.id, number: task.number, title: task.title },
    ],
    result: {
      number: `WV-${task.number}`,
      title: task.title,
      status: taskStatusLabels[task.status],
      priority: taskPriorityLabels[task.priority],
      assignee: task.assigneeName ?? '未分配',
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      updatedAt: task.updatedAt,
      comments: comments.rows.map((comment) => ({
        author: comment.authorName,
        reply: comment.reply,
        body: comment.body,
        at: comment.createdAt,
      })),
      history: events.rows.map((event) => ({
        by: event.actorName,
        at: event.createdAt,
        change:
          event.kind === 'create'
            ? event.fromProposal
              ? '确认 AI 提案后创建'
              : '创建'
            : trackedFields
                .filter(
                  (field) =>
                    taskHistoryValue(event.before, field) !==
                    taskHistoryValue(event.after, field),
                )
                .map(
                  (field) =>
                    `${taskFieldLabels[field]}：${taskHistoryValue(event.before, field)} → ${taskHistoryValue(event.after, field)}`,
                )
                .join('；') || '调整排序',
      })),
    },
  };
}

export const listDocumentsInput = z.object({});

export async function listDocuments(
  client: PoolClient,
  projectId: string,
): Promise<Lookup<unknown>> {
  const rows = await client.query<{
    id: string;
    title: string;
    version: number;
    updatedAt: Date;
    updatedByName: string;
    body: string;
  }>(
    `SELECT d.id, d.title, d.version, d.updated_at AS "updatedAt", u.name AS "updatedByName", d.body
     FROM documents d JOIN users u ON u.id = d.updated_by
     WHERE d.project_id = $1 ORDER BY d.updated_at DESC, d.id LIMIT 50`,
    [projectId],
  );
  return {
    summary: `列出文档，共 ${rows.rows.length} 篇`,
    refs: rows.rows.map((document) => ({
      type: 'document',
      id: document.id,
      title: document.title,
      version: document.version,
    })),
    result: rows.rows.map((document) => ({
      id: document.id,
      title: document.title,
      version: document.version,
      updatedBy: document.updatedByName,
      updatedAt: document.updatedAt,
      characters: document.body.length,
      // The same parser as readDocument, so every listed section can be read.
      outline: documentSections(document.body)
        .filter((section) => section.level <= 3)
        .slice(0, 30)
        .map((section) => section.heading),
    })),
  };
}

export const searchDocumentsInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('短关键词，例如「限流」，而不是整句问题'),
});

export async function searchDocuments(
  client: PoolClient,
  projectId: string,
  input: z.infer<typeof searchDocumentsInput>,
): Promise<Lookup<unknown>> {
  const rows = await client.query<{
    id: string;
    title: string;
    version: number;
    body: string;
  }>(
    `SELECT d.id, d.title, d.version, d.body FROM documents d
     WHERE d.project_id = $1 AND (d.title ILIKE $2 OR d.body ILIKE $2)
     ORDER BY (d.title ILIKE $2) DESC, d.updated_at DESC, d.id LIMIT 5`,
    [projectId, pattern(input.query)],
  );
  return {
    summary: `搜索文档「${input.query}」，找到 ${rows.rows.length} 篇`,
    refs: rows.rows.map((document) => ({
      type: 'document',
      id: document.id,
      title: document.title,
      version: document.version,
    })),
    result: rows.rows.map((document) => ({
      id: document.id,
      title: document.title,
      version: document.version,
      matches: snippets(document.body, input.query),
    })),
  };
}

export const readDocumentInput = z.object({
  id: z.string().describe('文档 id，来自 listDocuments 或 searchDocuments'),
  section: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .describe('要读的章节标题；读全文时为 null'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe('从第几个字符继续读，用上次返回的 nextOffset；从头读为 null'),
});

export async function readDocument(
  client: PoolClient,
  projectId: string,
  input: z.infer<typeof readDocumentInput>,
): Promise<Lookup<unknown>> {
  const id = z.uuid().safeParse(input.id);
  const found = id.success
    ? await client.query<{
        id: string;
        title: string;
        version: number;
        body: string;
      }>(
        'SELECT id, title, version, body FROM documents WHERE project_id = $1 AND id = $2',
        [projectId, id.data],
      )
    : { rows: [] };
  const document = found.rows[0];
  if (!document)
    return {
      summary: '读取文档，没有找到',
      refs: [],
      result: { error: '项目里没有这篇文档，请先用 listDocuments 查看。' },
    };
  const sections = documentSections(document.body);
  const wanted = input.section?.toLowerCase();
  const section = wanted
    ? sections.find((candidate) =>
        candidate.heading.toLowerCase().includes(wanted),
      )
    : undefined;
  const range = section
    ? document.body.slice(section.start, section.end)
    : document.body;
  const offset = Math.min(input.offset ?? 0, range.length);
  const end = Math.min(range.length, offset + maxReadChars);
  return {
    summary: `阅读《${document.title}》${section ? `「${section.heading}」` : ''}`,
    refs: [
      {
        type: 'document',
        id: document.id,
        title: document.title,
        version: document.version,
      },
    ],
    result: {
      id: document.id,
      title: document.title,
      version: document.version,
      ...(wanted && !section
        ? { notice: `没有标题包含「${input.section}」的章节，返回全文开头。` }
        : {}),
      section: section?.heading ?? null,
      content: range.slice(offset, end),
      nextOffset: end < range.length ? end : null,
      sections: sections.map((candidate) => candidate.heading),
    },
  };
}

// Builds the tools for one AI run. `used` keeps every record the model saw, so
// the answer can only cite what it actually looked at.
export function knowledgeTools(
  userId: string,
  projectId: string,
  runId: string,
  onLookup?: (summary: string) => void,
) {
  let position = 0;
  const used = new Map<string, MessageSource>();
  const run = (
    name: string,
    input: unknown,
    lookup: (client: PoolClient) => Promise<Lookup<unknown>>,
  ) => {
    const step = ++position;
    return transaction(async (client) => {
      await loadProject(client, userId, projectId, false);
      const { result, summary, refs } = await lookup(client);
      await client.query(
        `INSERT INTO ai_run_steps(id, ai_run_id, position, tool, input, summary, refs)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          runId,
          step,
          name,
          JSON.stringify(input),
          summary.slice(0, 300),
          JSON.stringify(refs),
        ],
      );
      for (const ref of refs)
        used.set(
          ref.type === 'task' ? `task:${ref.number}` : `document:${ref.id}`,
          ref,
        );
      onLookup?.(summary);
      return result;
    });
  };
  const tools = {
    searchTasks: tool({
      description:
        '按关键词、状态、优先级或负责人查找本项目的任务。返回编号、标题、状态和摘要。',
      inputSchema: searchTasksInput,
      execute: (input) =>
        run('searchTasks', input, (client) =>
          searchTasks(client, userId, projectId, input),
        ),
    }),
    getTask: tool({
      description:
        '按编号读取一个任务的完整内容：描述、验收标准、评论和最近的变更历史。',
      inputSchema: getTaskInput,
      execute: (input) =>
        run('getTask', input, (client) => getTask(client, projectId, input)),
    }),
    listDocuments: tool({
      description: '列出本项目的文档，包括标题、版本和目录，用来决定读哪一篇。',
      inputSchema: listDocumentsInput,
      execute: (input) =>
        run('listDocuments', input, (client) =>
          listDocuments(client, projectId),
        ),
    }),
    searchDocuments: tool({
      description:
        '按关键词在本项目文档的标题和正文里查找，返回命中的片段。只做字面匹配，没找到时可以换个说法或先看目录。',
      inputSchema: searchDocumentsInput,
      execute: (input) =>
        run('searchDocuments', input, (client) =>
          searchDocuments(client, projectId, input),
        ),
    }),
    readDocument: tool({
      description: `读取一篇文档，可以只读某个章节。每次最多返回 ${maxReadChars} 个字符，用 nextOffset 继续读。`,
      inputSchema: readDocumentInput,
      execute: (input) =>
        run('readDocument', input, (client) =>
          readDocument(client, projectId, input),
        ),
    }),
  };
  function resolveSources(
    cited: {
      type: 'task' | 'document';
      taskNumber: number | null;
      documentId: string | null;
    }[],
  ) {
    const sources = new Map<string, MessageSource>();
    for (const item of cited) {
      const key =
        item.type === 'task'
          ? `task:${item.taskNumber}`
          : `document:${item.documentId}`;
      const source = used.get(key);
      if (source) sources.set(key, source);
    }
    return [...sources.values()];
  }
  return { tools, resolveSources };
}
