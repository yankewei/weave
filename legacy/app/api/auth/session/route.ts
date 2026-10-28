import { currentUser } from '@/lib/auth';
import { ApiError, json, handler } from '@/lib/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const user = await currentUser();
  if (!user) throw new ApiError(401, '请先登录。');
  return json(user);
});
