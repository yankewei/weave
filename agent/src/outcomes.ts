import {
  defineTask,
  type Task,
  type TaskId,
  type Tx,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { Admissions, Inputs, Outcomes } from './state.ts';

type Result = {
  status: 'succeeded' | 'failed';
  model: string;
  error: string | null;
};
type Input = { requestId: string; runId: string; model: string };
type Checkpoint =
  { phase: 'poll' } | { phase: 'deliver'; result: Result; attempt: number };

export function outcomeTask(baseUrl: string, token: string) {
  return defineTask<Input, Checkpoint, null>({
    name: 'weave.outcome',
    version: 1,
    initial: () => ({ phase: 'poll' }),
    phases: {
      poll: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const submission = await tx.submissionByRequest(
            runtime.conversationId,
            task.input.requestId,
          );
          const input = await tx.doc(
            Inputs,
            runtime.conversationId,
            task.input.requestId,
            null,
          );
          const admission = await tx.doc(
            Admissions,
            runtime.conversationId,
            input.admissionId,
            { requestId: input.requestId, runId: input.runId, closed: false },
          );
          if (!submission && admission.closed)
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: null },
            };
          if (
            !submission ||
            submission.status === 'queued' ||
            submission.status === 'placed'
          )
            return {
              status: 'sleeping',
              until: runtime.now() + 250,
              checkpoint: { phase: 'poll' },
            };
          let model = task.input.model;
          if (submission.type === 'input' && submission.status === 'done') {
            const answer = await tx.entry(submission.answer);
            const message = answer?.model?.find(
              (entry) => entry.role === 'assistant',
            );
            if (message?.role === 'assistant') model = message.model;
          }
          return {
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              attempt: 0,
              result: {
                status: submission.status === 'done' ? 'succeeded' : 'failed',
                model,
                error:
                  submission.status === 'done'
                    ? null
                    : '生成失败，请重新发送。',
              },
            },
          };
        }, context);
      },
      deliver: async (task, runtime, context) => {
        try {
          const response = await fetch(
            new URL(
              `/internal/agent/runs/${task.input.runId}/outcome`,
              baseUrl,
            ),
            {
              method: 'PUT',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(task.state.checkpoint.result),
              redirect: 'error',
              signal: AbortSignal.any([
                runtime.signal,
                AbortSignal.timeout(5000),
              ]),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Outcome was not acknowledged');
          }
          const receipt: unknown = await response.json();
          if (
            !receipt ||
            typeof receipt !== 'object' ||
            !('status' in receipt) ||
            receipt.status !== 'acknowledged'
          )
            throw new Error('Invalid outcome receipt');
          await runtime.commit(async (tx) => {
            (
              await tx.doc(
                Outcomes,
                runtime.conversationId,
                task.input.requestId,
                null,
              )
            ).synced = true;
            return {
              status: 'terminal',
              outcome: { status: 'completed', result: null },
            };
          }, context);
        } catch {
          if (runtime.signal.aborted)
            throw new Error('Outcome delivery cancelled');
          await runtime.sleepUntil(
            runtime.now() +
              Math.min(
                30000,
                500 * 2 ** Math.min(task.state.checkpoint.attempt, 6),
              ),
            {
              ...task.state.checkpoint,
              attempt: task.state.checkpoint.attempt + 1,
            },
            context,
          );
        }
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
        context,
      );
    },
  });
}

// Atomically journal the recovery work alongside preparation. A closed, unsubmitted
// attempt may be retried later under the same requestId and needs a new observer.
export async function ensureOutcome(
  tx: Tx,
  conversationId: ConversationId,
  input: Input,
  definition: Task<Input, Checkpoint, null, object>,
) {
  const outcome = await tx.doc(Outcomes, conversationId, input.requestId, null);
  const previous =
    outcome.taskId === null
      ? undefined
      : await tx.task(outcome.taskId as TaskId);
  if (outcome.synced || (previous && previous.state.status !== 'terminal'))
    return;
  outcome.taskId = await tx.createTask(definition, input, {
    conversationId,
    ownership: { kind: 'conversation' },
    background: true,
  });
}
