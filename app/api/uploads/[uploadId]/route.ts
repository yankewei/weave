import { requireUser } from '@/lib/auth';
import { handler, uuid } from '@/lib/http';
import { open } from '@/lib/services/uploads';

export const dynamic = 'force-dynamic';

// Every read checks current membership, so the browser may cache only privately
// and briefly; a removed member loses access once this expires.
export const GET = handler<{ uploadId: string }>(
  async (_request, { uploadId }) => {
    const user = await requireUser();
    const upload = await open(user.id, uuid(uploadId, '图片'));
    return new Response(upload.stream, {
      headers: {
        'Content-Type': upload.contentType,
        'Content-Length': String(upload.size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(upload.fileName)}`,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  },
);
