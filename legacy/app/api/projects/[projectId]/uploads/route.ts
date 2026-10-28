import { imageUploadMaxBytes } from '@/lib/contracts';
import { requireUser } from '@/lib/auth';
import { ApiError, handler, json, uuid } from '@/lib/http';
import { create } from '@/lib/services/uploads';

export const dynamic = 'force-dynamic';

export const POST = handler<{ projectId: string }>(
  async (request, { projectId }) => {
    const user = await requireUser();
    // Reject oversized bodies before buffering them; multipart adds a little overhead.
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > imageUploadMaxBytes + 64 * 1024)
      throw new ApiError(413, '图片不能超过 4 MB。');
    const form = await request.formData().catch(() => {
      throw new ApiError(400, '请选择要上传的图片。');
    });
    const file = form.get('file');
    if (!(file instanceof File))
      throw new ApiError(400, '请选择要上传的图片。');
    return json(
      await create(user.id, uuid(projectId, '项目'), {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }),
      201,
    );
  },
);
