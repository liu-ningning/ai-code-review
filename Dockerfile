# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24-bookworm-slim
ARG PNPM_VERSION=10.33.0

FROM node:${NODE_VERSION} AS base

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@${PNPM_VERSION} --activate

FROM base AS prod-deps

COPY package.json pnpm-lock.yaml .npmrc ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile

FROM base AS build

COPY package.json pnpm-lock.yaml .npmrc tsconfig.json ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY src ./src

RUN pnpm build

FROM node:${NODE_VERSION} AS runner

ENV NODE_ENV=production
ENV PORT=9527

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app \
  && chown -R node:node /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER node

EXPOSE 9527

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 9527) + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/entry/index.js"]
