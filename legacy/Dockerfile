# Built from the repository root so pnpm sees the workspace lockfile.
FROM node:24-alpine AS build

RUN npm install --global pnpm@11.11.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY legacy/package.json legacy/
RUN pnpm install --frozen-lockfile --filter weave-legacy
COPY legacy legacy
RUN pnpm --filter weave-legacy build

# One-off job for `docker compose`: applies migrations/ to the compose database.
FROM node:24-alpine AS migrate

RUN npm install --global pnpm@11.11.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY legacy/package.json legacy/
RUN pnpm install --frozen-lockfile --prod --filter weave-legacy
# Owned by node so host file modes cannot make them unreadable.
COPY --chown=node legacy/scripts/migrate.mjs legacy/scripts/
COPY --chown=node migrations migrations
USER node
WORKDIR /app/legacy
CMD ["node", "scripts/migrate.mjs"]

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node /app/legacy/.next/standalone ./
COPY --from=build --chown=node /app/legacy/.next/static ./legacy/.next/static
EXPOSE 3000
USER node
CMD ["node", "legacy/server.js"]
