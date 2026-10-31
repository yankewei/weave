# Built from the repository root: the image serves the web SPA it builds.
FROM node:24-alpine AS build

RUN npm install --global pnpm@11.11.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter weave-web
COPY web web
RUN pnpm --filter weave-web build

FROM nginx:1.29-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
