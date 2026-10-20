# NOT BUILT OR RUN YET: written for review. Build from the repository root: docker build -f apps/agent-server/Dockerfile .
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @recast/agent-server...
ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "--filter", "@recast/agent-server", "start"]
