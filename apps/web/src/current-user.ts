import { createContext, useContext } from 'react';
import type { User } from '@weave/contracts';

export const CurrentUserContext = createContext<User | null>(null);
export const LeaveWorkspaceContext = createContext<
  (() => Promise<void>) | null
>(null);

export function useCurrentUser() {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error('缺少当前用户。');
  return user;
}

export function useLeaveWorkspace() {
  const leave = useContext(LeaveWorkspaceContext);
  if (!leave) throw new Error('缺少工作空间操作。');
  return leave;
}
