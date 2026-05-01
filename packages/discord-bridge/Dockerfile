FROM oven/bun:1.1 AS builder

WORKDIR /build

COPY package.json tsconfig.json ./
COPY src ./src

RUN bun install --frozen-lockfile || bun install
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

COPY --from=builder /build/dist ./dist
COPY litestream.yml /etc/litestream.yml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV BRIDGE_DATA_DIR=/data
ENV BRIDGE_DB_PATH=/data/bridge.sqlite

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
