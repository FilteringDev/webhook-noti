# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 node:24-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY apps/notifier/package.json apps/notifier/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/testunit/package.json packages/testunit/package.json
RUN pnpm install --lockfile=false
COPY . .
RUN pnpm --filter @webhook-noti/notifier --prod deploy --config.inject-workspace-packages=true /out

FROM --platform=linux/amd64 node:24-alpine AS runtime

RUN addgroup -S -g 10001 webhook && adduser -S -D -H -u 10001 -G webhook webhook
WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./
ENV NODE_ENV=production \
    DATA_DIR=/var/lib/webhook-noti \
    PORT=3000
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--import", "tsx", "source/main.ts"]