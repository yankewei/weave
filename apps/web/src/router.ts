import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import {
  NotFoundPage,
  RootLayout,
  WorkspaceIndex,
  WorkspaceRoute,
} from './session.js';

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspaceIndex,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces/$workspaceId',
  component: WorkspaceRoute,
});

const settingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings',
});

const projectRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'projects/$projectId',
});

const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
});

const boardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'board',
});

const documentRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'documents/$documentId',
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  workspaceRoute.addChildren([
    settingsRoute,
    projectRoute.addChildren([projectIndexRoute, boardRoute, documentRoute]),
  ]),
]);

export function createWeaveRouter() {
  return createRouter({
    routeTree,
    defaultNotFoundComponent: NotFoundPage,
  });
}

type WeaveRouter = ReturnType<typeof createWeaveRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: WeaveRouter;
  }
}
