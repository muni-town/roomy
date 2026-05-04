FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /build

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/discord-bridge packages/discord-bridge
COPY packages/sdk packages/sdk
COPY packages/tsconfig packages/tsconfig
COPY patches patches

RUN pnpm install --frozen-lockfile --filter @roomy/discord-bridge... --ignore-scripts

RUN npm install -g bun@1.1

WORKDIR /build/packages/discord-bridge
RUN bun build src/index.ts --target=bun --outdir=dist --minify

FROM oven/bun:1.1-slim

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
