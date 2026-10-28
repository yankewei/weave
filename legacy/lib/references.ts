// Tasks and documents are referenced by workspace-wide keys such as DEV-12
// and DOC-3. Matching ignores case so a typed "dev-12" still resolves.
export type ReferenceKind = 'task' | 'document';

export type Reference = { kind: ReferenceKind; number: number; key: string };

const prefixes = { task: 'DEV', document: 'DOC' } as const;

// Only ASCII word characters break a key, so "看看DEV-12的描述" still matches.
const pattern = /(?<![A-Za-z0-9_-])(DEV|DOC)-([1-9]\d{0,8})(?![A-Za-z0-9_])/gi;

export const taskKey = (number: number) => `${prefixes.task}-${number}`;
export const documentKey = (number: number) => `${prefixes.document}-${number}`;

export function parseReference(value: string): Reference | null {
  const match = /^(DEV|DOC)-([1-9]\d{0,8})$/i.exec(value.trim());
  return match ? reference(match[1]!, match[2]!) : null;
}

/** Splits text into plain runs and key references, in order. */
export function splitReferences(text: string) {
  const parts: (string | Reference)[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(reference(match[1]!, match[2]!));
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function findReferences(text: string) {
  const unique = new Map<string, Reference>();
  for (const part of splitReferences(text))
    if (typeof part !== 'string') unique.set(part.key, part);
  return [...unique.values()];
}

export const referencePath = (workspaceId: string, key: string) =>
  `/workspaces/${workspaceId}/browse/${key}`;

function reference(prefix: string, digits: string): Reference {
  const kind = prefix.toUpperCase() === prefixes.task ? 'task' : 'document';
  const number = Number(digits);
  return {
    kind,
    number,
    key: kind === 'task' ? taskKey(number) : documentKey(number),
  };
}
