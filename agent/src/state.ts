import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';

export type Binding = {
  agentConversationId: number;
  workspaceId: string;
  projectId: string;
  ownerId: string;
  importing: boolean;
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
  importedCount: number;
  importDigest: string;
  importTail: string;
  sealed: boolean;
}>({
  kind: 'weave.state',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    latestRequestId: null,
    importedCount: 0,
    importDigest: '0'.repeat(64),
    importTail: '',
    sealed: true,
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
export const Batches = defineDocFamily<{ hash: string }, string>({
  kind: 'weave.import-batch',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: (hash) => ({ hash }),
  checkpointWhen: () => true,
});
export const ImportedIds = defineDocFamily<{ present: boolean }, boolean>({
  kind: 'weave.import-id',
  version: 1,
  family: true,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: (present) => ({ present }),
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
