# Build context: the repo root (see deploy/docker-compose.yml).
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

# Every workspace manifest, so the frozen lockfile resolves; only this service's deps install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/landing/package.json apps/landing/
COPY packages/shared/package.json packages/shared/
COPY packages/stellar/package.json packages/stellar/
COPY packages/settlement-saga/package.json packages/settlement-saga/
COPY services/orchestrator/package.json services/orchestrator/
COPY services/anchor-business/package.json services/anchor-business/
RUN pnpm install --frozen-lockfile --prod --filter @corra/anchor-business

COPY services/anchor-business ./services/anchor-business

ENV NODE_ENV=production
EXPOSE 8091
CMD ["pnpm", "--filter", "@corra/anchor-business", "start"]
