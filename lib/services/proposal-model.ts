import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  NoOutputGeneratedError,
  Output,
  stepCountIs,
  streamText,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { taskPrioritySchema } from '@/lib/contracts';
import { ApiError } from '../http';

const proposedTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000),
    acceptanceCriteria: z.string().trim().max(20_000),
    priority: taskPrioritySchema,
  })
  .strict();

// Flat rather than a union so providers with strict JSON schema accept it.
const citedSourceSchema = z
  .object({
    type: z.enum(['task', 'document']),
    taskNumber: z.number().int().positive().nullable(),
    documentId: z.string().nullable(),
  })
  .strict();

// While a proposal waits for the user, the model may answer but not propose.
export function proposalDraftSchema(allowTasks: boolean) {
  return z
    .object({
      reply: z.string().trim().min(1).max(4_000),
      tasks: z.array(proposedTaskSchema).max(allowTasks ? 8 : 0),
      sources: z.array(citedSourceSchema).max(10),
    })
    .strict();
}

export type TaskProposalDraft = z.infer<ReturnType<typeof proposalDraftSchema>>;

export const defaultCommandCodeModelId = 'deepseek/deepseek-v4.1-flash';

export function commandCodeModelId() {
  return process.env.CMD_MODEL?.trim() || defaultCommandCodeModelId;
}

function apiKey() {
  const key = process.env.CMD_API_KEY?.trim();
  if (!key)
    throw new ApiError(
      503,
      '尚未配置 CMD_API_KEY，无法生成任务提案。密钥只放在服务端。',
    );
  return key;
}

export function assertModelReady() {
  apiKey();
}

// Lookups plus the final structured answer; generating the answer is a step too.
const maxSteps = 6;

export async function streamProposal(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  options: {
    tools: ToolSet;
    allowTasks: boolean;
    onReply: (reply: string) => void;
    signal?: AbortSignal;
  },
): Promise<TaskProposalDraft> {
  const { tools, allowTasks, onReply, signal } = options;
  const key = apiKey();
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation = messages.flatMap((message) =>
    message.role === 'system'
      ? []
      : [{ role: message.role, content: message.content }],
  );
  try {
    const commandCode = createOpenAICompatible({
      name: 'command-code',
      apiKey: key,
      baseURL: 'https://api.commandcode.ai/provider/v1',
      supportsStructuredOutputs: true,
    });
    const result = streamText({
      model: commandCode.chatModel(commandCodeModelId()),
      ...(instructions ? { instructions } : {}),
      messages: conversation,
      temperature: 0.2,
      maxRetries: 0,
      timeout: 55_000,
      ...(signal ? { abortSignal: signal } : {}),
      tools,
      stopWhen: stepCountIs(maxSteps),
      output: Output.object({ schema: proposalDraftSchema(allowTasks) }),
    });
    let latest = '';
    for await (const partial of result.partialOutputStream) {
      const reply =
        partial &&
        typeof partial === 'object' &&
        'reply' in partial &&
        typeof partial.reply === 'string'
          ? partial.reply
          : '';
      if (!reply || reply === latest) continue;
      latest = reply;
      onReply(reply);
    }
    const output = await result.output;
    if (!output) throw new ApiError(502, '模型没有返回提案，没有创建任务。');
    return output;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (APICallError.isInstance(error))
      throw new ApiError(502, '模型请求失败，没有创建任务。');
    if (NoOutputGeneratedError.isInstance(error))
      throw new ApiError(502, '模型没有返回提案，没有创建任务。');
    throw new ApiError(502, '模型输出无法通过校验，没有创建任务。');
  }
}
