import { describe, expect, it } from 'vitest';
import { findReferences, parseReference, splitReferences } from './references';

describe('task and document keys', () => {
  it('finds keys inside Chinese text and ignores case', () => {
    expect(splitReferences('看看dev-12的描述，再对照 DOC-3。')).toEqual([
      '看看',
      { kind: 'task', number: 12, key: 'DEV-12' },
      '的描述，再对照 ',
      { kind: 'document', number: 3, key: 'DOC-3' },
      '。',
    ]);
  });

  it.each(['ADEV-1', 'DEV-12a', 'DEV-0', 'DEV-01', 'X-DEV-1', 'DEV_1'])(
    'leaves %s as plain text',
    (text) => {
      expect(splitReferences(text)).toEqual([text]);
    },
  );

  it('lists each key once in order of appearance', () => {
    expect(
      findReferences('DOC-2 DEV-1 doc-2').map((reference) => reference.key),
    ).toEqual(['DOC-2', 'DEV-1']);
  });

  it('parses a whole key only', () => {
    expect(parseReference('doc-7')).toEqual({
      kind: 'document',
      number: 7,
      key: 'DOC-7',
    });
    expect(parseReference('DOC-7 extra')).toBeNull();
  });
});
