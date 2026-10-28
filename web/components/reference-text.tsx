import { useParams } from 'react-router';
import {
  findReferences,
  referencePath,
  splitReferences,
} from '@/lib/references';
import { FieldDescription } from '@/components/ui/field';

/**
 * Plain text with DEV-n and DOC-n turned into links. Links open a new tab so
 * the conversation and any unsaved draft on this page stay put.
 */
export function ReferenceText({ text }: { text: string }) {
  const { workspaceId = '' } = useParams();
  return splitReferences(text).map((part, index) =>
    typeof part === 'string' ? (
      part
    ) : (
      <a
        key={index}
        href={referencePath(workspaceId, part.key)}
        target="_blank"
        rel="noreferrer"
        // An inline text link has no component variant; like .document-content a
        // it only underlines, inheriting colour and size so it reads on the
        // primary user bubble and in small print alike.
        className="font-medium underline underline-offset-4"
      >
        {part.key}
      </a>
    ),
  );
}

/** Under a plain textarea, lists the keys its text references as links. */
export function ReferencedKeys({ text }: { text: string }) {
  const keys = findReferences(text).map((reference) => reference.key);
  if (!keys.length) return null;
  return (
    <FieldDescription>
      引用：
      <ReferenceText text={keys.join('、')} />
    </FieldDescription>
  );
}
