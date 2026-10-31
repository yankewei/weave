# One-off job for `docker compose`: applies migrations/ inside the compose network.
# Built from the repository root so pnpm sees the workspace lockfile.
FROM node:24-alpine

RUN npm install --global pnpm@11.11.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY migrate/package.json migrate/
RUN pnpm install --frozen-lockfile --prod --filter weave-migrate
# Owned by node so host file modes cannot make them unreadable.
COPY --chown=node migrate/migrate.mjs migrate/
COPY --chown=node migrations migrations
USER node
WORKDIR /app/migrate
CMD ["node", "migrate.mjs"]
