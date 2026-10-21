import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('weave-api'),
});

export const readinessResponseSchema = healthResponseSchema.extend({
  database: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

export const credentialsSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
export const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(80),
  workspaceName: z.string().trim().min(1).max(100),
});
export const userSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
});
export const workspaceSchema = z.object({ id: z.uuid(), name: z.string() });
const storageEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'https:' || url.protocol === 'http:') &&
          url.username === '' &&
          url.password === '' &&
          url.pathname === '/' &&
          url.search === '' &&
          url.hash === ''
        );
      } catch {
        return false;
      }
    },
    { message: '请填写对象存储的服务地址。' },
  )
  .transform((value) => new URL(value).origin);
export const workspaceStorageInputSchema = z
  .object({
    endpoint: storageEndpointSchema,
    region: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,64}$/, '请填写存储区域。'),
    bucket: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
        '桶名需要使用小写字母、数字和连字符。',
      ),
    prefix: z
      .string()
      .trim()
      .max(200)
      .refine(
        (value) =>
          value === '' ||
          (/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(value) &&
            !value.includes('..') &&
            !value.endsWith('/')),
        { message: '目录只能包含字母、数字、斜线和连字符。' },
      ),
    accessKeyId: z.string().trim().min(1).max(128),
    secretAccessKey: z
      .string()
      .max(256)
      .optional()
      .transform((value) => {
        const trimmed = value?.trim() ?? '';
        return trimmed.length > 0 ? trimmed : undefined;
      }),
  })
  .strict();
export const workspaceStorageSchema = z.object({
  endpoint: z.string(),
  region: z.string(),
  bucket: z.string(),
  prefix: z.string(),
  accessKeyId: z.string(),
});
export const workspaceStorageStateSchema = z.object({
  storage: workspaceStorageSchema.nullable(),
});
// Uploads go through the app body limit, so stay below Vercel's 4.5 MB.
export const imageUploadMaxBytes = 4 * 1024 * 1024;
export const imageUploadTypes = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
export const uploadSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  fileName: z.string(),
});
export const projectInputSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
export const projectSchema = projectInputSchema.extend({
  id: z.uuid(),
  workspaceId: z.uuid(),
});
export const documentInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(200_000),
  })
  .strict();
export const updateDocumentSchema = documentInputSchema.extend({
  baseVersion: z.number().int().positive(),
});
export const restoreDocumentSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    revisionVersion: z.number().int().positive(),
  })
  .strict();
export const documentSchema = documentInputSchema.extend({
  id: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export const revisionSchema = documentInputSchema.extend({
  version: z.number().int().positive(),
  actorName: z.string(),
  createdAt: z.string(),
  operationId: z.uuid(),
  kind: z.enum(['create', 'edit', 'restore']),
  restoredFromVersion: z.number().int().positive().nullable(),
});
export const documentSummarySchema = documentSchema.omit({ body: true });
export type User = z.infer<typeof userSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceStorage = z.infer<typeof workspaceStorageSchema>;
export type WorkspaceStorageInput = z.infer<typeof workspaceStorageInputSchema>;
export type WorkspaceStorageState = z.infer<typeof workspaceStorageStateSchema>;
export type Upload = z.infer<typeof uploadSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Document = z.infer<typeof documentSchema>;
export type DocumentSummary = z.infer<typeof documentSummarySchema>;
export type Revision = z.infer<typeof revisionSchema>;

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'done']);
export const taskPrioritySchema = z.enum(['low', 'normal', 'high']);
export const taskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    acceptanceCriteria: z.string().max(20_000),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    assigneeId: z.uuid().nullable(),
  })
  .strict();
export const taskSchema = taskInputSchema.extend({
  id: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  number: z.number().int().positive(),
  position: z.string(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
  assigneeName: z.string().nullable(),
});
export const updateTaskSchema = taskInputSchema.extend({
  baseVersion: z.number().int().positive(),
});
export const moveTaskSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    status: taskStatusSchema,
    beforeTaskId: z.uuid().nullable(),
  })
  .strict();
export const projectMemberSchema = z.object({ id: z.uuid(), name: z.string() });
export const memberRoleSchema = z.enum(['admin', 'member']);
export const workspaceMemberSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  role: memberRoleSchema,
});
export const inviteMemberSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const membershipChangeSchema = z.object({
  unassignedTaskCount: z.number().int().nonnegative(),
  rejectedProposalCount: z.number().int().nonnegative(),
});
export const taskEventSchema = z.object({
  operationId: z.uuid(),
  version: z.number().int().positive(),
  kind: z.enum(['create', 'edit', 'move']),
  actorName: z.string(),
  createdAt: z.string(),
  before: taskSchema.nullable(),
  after: taskSchema,
  proposalId: z.uuid().nullable(),
});
export const taskCommentInputSchema = z
  .object({
    body: z.string().trim().min(1).max(4_000),
    parentId: z.uuid().nullable().optional(),
  })
  .strict();
export const taskCommentSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  parentId: z.uuid().nullable(),
  authorId: z.uuid(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
export type TaskComment = z.infer<typeof taskCommentSchema>;
export type TaskCommentInput = z.infer<typeof taskCommentInputSchema>;
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type MembershipChange = z.infer<typeof membershipChangeSchema>;

export const conversationMessageInputSchema = z
  .object({ body: z.string().trim().min(1).max(8_000) })
  .strict();
export const conversationMessageSchema = z.object({
  id: z.uuid(),
  authorType: z.enum(['user', 'assistant']),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export const proposalItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string(),
  priority: taskPrioritySchema,
  taskId: z.uuid().nullable(),
  taskNumber: z.number().int().positive().nullable(),
});
export const proposalSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'applied', 'rejected']),
  summary: z.string(),
  items: z.array(proposalItemSchema),
});
export const conversationSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  messages: z.array(conversationMessageSchema),
  proposal: proposalSchema.nullable(),
});
export const conversationStateSchema = z.object({
  conversation: conversationSchema.nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
