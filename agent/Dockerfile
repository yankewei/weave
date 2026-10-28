# Built from the repository root so pnpm sees the workspace lockfile.
FROM node:24-alpine

RUN npm install --global pnpm@11.11.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent/package.json agent/
RUN pnpm install --frozen-lockfile --prod --filter weave-agent
COPY agent/src agent/src

RUN mkdir /data && chown node /data
ENV AGENT_HOST=0.0.0.0 AGENT_PORT=8090 AGENT_STORAGE_PATH=/data/agent.sqlite
EXPOSE 8090
USER node
WORKDIR /app/agent
CMD ["node", "src/server.ts"]
