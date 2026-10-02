FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/discord-bridge packages/discord-bridge
COPY packages/sdk packages/sdk
COPY packages/tsconfig packages/tsconfig
COPY patches patches

RUN pnpm install --frozen-lockfile --filter @roomy/discord-bridge... --ignore-scripts

RUN pnpm --filter @roomy-space/sdk build

RUN npm install -g bun@1.3.14

WORKDIR /build/packages/discord-bridge

# The migration script is a second entry point so it ships in the runtime
# image: the deployed container has no sqlite3 CLI, and this is the only way
# to rewrite forward-dedup rows there. See README "Data migrations".
RUN bun build src/index.ts src/scripts/migrate-forward-mappings.ts --target=bun --outdir=dist --minify

FROM oven/bun:1.3.14

# Build identity for log records (see src/telemetry/build.ts). Docker does NOT
# propagate ARG/ENV across stages, so a pair declared in the `builder` stage
# above would be invisible here — the bridge RUNS from this stage, and the
# logger reads `BUILD_ID` from this very container's environment. Declaring it
# only where the process runs is what makes `build_id` name a commit instead of
# saying "unknown" on all 28k log lines in a week.
#
# The ARG is also a deliberate cache-buster: referencing it in ENV puts its
# value in this layer's cache key, so a new commit rebuilds the layers below
# rather than reusing a runtime image built from a different commit (same
# property as Dockerfile.appserver).
ARG RAILWAY_GIT_COMMIT_SHA
ENV BUILD_ID=${RAILWAY_GIT_COMMIT_SHA%"${RAILWAY_GIT_COMMIT_SHA#??*??????}"}

ARG LITESTREAM_VERSION=0.3.13
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && wget -q -O /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
 && tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz \
 && rm /tmp/litestream.tar.gz \
 && apt-get purge -y wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/packages/discord-bridge/dist ./dist
COPY --from=builder /build/packages/discord-bridge/litestream.yml /etc/litestream.yml
COPY --from=builder /build/packages/discord-bridge/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV BRIDGE_DATA_DIR=/data
ENV BRIDGE_DB_PATH=/data/bridge.sqlite

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
