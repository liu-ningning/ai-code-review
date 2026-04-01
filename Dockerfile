ARG BASE_IMAGE=node:24-alpine
ARG PNPM_VERSION=10.33.0
ARG PNPM_FETCH_TIMEOUT=30000
ARG PNPM_FETCH_RETRIES=1
ARG PNPM_FETCH_RETRY_MINTIMEOUT=3000
ARG PNPM_FETCH_RETRY_MAXTIMEOUT=10000

FROM ${BASE_IMAGE} AS builder

ARG PNPM_VERSION
ARG PNPM_FETCH_TIMEOUT
ARG PNPM_FETCH_RETRIES
ARG PNPM_FETCH_RETRY_MINTIMEOUT
ARG PNPM_FETCH_RETRY_MAXTIMEOUT

WORKDIR /app

ENV npm_config_fetch_timeout=${PNPM_FETCH_TIMEOUT} \
    npm_config_fetch_retries=${PNPM_FETCH_RETRIES} \
    npm_config_fetch_retry_mintimeout=${PNPM_FETCH_RETRY_MINTIMEOUT} \
    npm_config_fetch_retry_maxtimeout=${PNPM_FETCH_RETRY_MAXTIMEOUT}

# Ensure pnpm is available when building without a pre-baked base image
RUN command -v pnpm >/dev/null 2>&1 || (corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate)

# Copy configuration files
COPY package.json pnpm-lock.yaml tsconfig.json .npmrc ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src ./src

# Build the project
RUN pnpm build

FROM ${BASE_IMAGE} AS runner

ARG PNPM_VERSION
ARG PNPM_FETCH_TIMEOUT
ARG PNPM_FETCH_RETRIES
ARG PNPM_FETCH_RETRY_MINTIMEOUT
ARG PNPM_FETCH_RETRY_MAXTIMEOUT

WORKDIR /app
ENV NODE_ENV=production
ENV npm_config_fetch_timeout=${PNPM_FETCH_TIMEOUT} \
    npm_config_fetch_retries=${PNPM_FETCH_RETRIES} \
    npm_config_fetch_retry_mintimeout=${PNPM_FETCH_RETRY_MINTIMEOUT} \
    npm_config_fetch_retry_maxtimeout=${PNPM_FETCH_RETRY_MAXTIMEOUT}

# Ensure runtime dependencies are available when building without a pre-baked base image
RUN command -v git >/dev/null 2>&1 || ( \
  if command -v apk >/dev/null 2>&1; then \
    apk add --no-cache git; \
  elif command -v apt-get >/dev/null 2>&1; then \
    apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*; \
  else \
    echo "No supported package manager found to install git" >&2; \
    exit 1; \
  fi \
)
RUN command -v pnpm >/dev/null 2>&1 || (corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate)

# Copy dependency manifests first so production install can stay cached
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/.npmrc ./.npmrc

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy build artifacts after dependencies to avoid invalidating the install layer
COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Set the entry point
CMD ["node", "dist/entry/index.js"]
