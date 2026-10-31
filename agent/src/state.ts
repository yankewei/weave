import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';

export type Binding = {
  agentConversationId: number;
  workspaceId: string;
  projectId: string;
  ownerId: string;
};
export const Index = defineDoc<{ items: Record<string, Binding> }>({
  kind: 'weave.conversations',
  version: 1,
  scope: 'session',
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
});
export const State = defineDoc<{
  latestRequestId: string | null;
}>({
  kind: 'weave.state',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    latestRequestId: null,
  }),
  checkpointWhen: () => true,
});
export type Input = {
  requestId: string;
  runId: string;
  admissionId: string;
  body: string;
  authorName: string;
  messageId: string;
  createdAt: string;
};
export const Inputs = defineDocFamily<Input, Input | null>({
  kind: 'weave.input',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: (seed) => {
    if (!seed) throw new Error('Missing persisted input journal');
    return seed;
  },
  checkpointWhen: () => true,
});
export const Admissions = defineDocFamily<
  { requestId: string; runId: string; closed: boolean },
  { requestId: string; runId: string; closed: boolean }
>({
  kind: 'weave.admission',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: (seed) => seed,
  checkpointWhen: () => true,
});
export const Outcomes = defineDocFamily<
  { taskId: number | null; synced: boolean },
  null
>({
  kind: 'weave.outcome',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ taskId: null, synced: false }),
  checkpointWhen: () => true,
});
