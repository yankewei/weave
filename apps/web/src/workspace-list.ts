import { createContext, useContext } from 'react';
import type { Workspace } from '@weave/contracts';

export const WorkspaceListContext = createContext<Workspace[]>([]);

export function useWorkspaces() {
  return useContext(WorkspaceListContext);
}
