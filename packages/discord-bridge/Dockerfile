FROM node:22 AS builder

# Add certificate and uncomment if building behind proxy with custom cert
# COPY ./gitignore/ca-certificates.crt /etc/ssl/cert.pem
# ENV NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem

COPY . /project
WORKDIR /project
RUN npm i -g pnpm
RUN pnpm i
RUN cd packages/discord-bridge && pnpm build
WORKDIR /project/packages/discord-bridge

ENV PORT=3301
ENV DISCORD_TOKEN=""
ENV ATPROTO_BRIDGE_DID=""
ENV ATPROTO_BRIDGE_APP_PASSWORD=""
ENV LEAF_URL="https://leaf.muni.town"
ENV STREAM_NSID="space.roomy.space.personal"
ENV STREAM_HANDLE_NSID="space.roomy.space.handle"

ENTRYPOINT ["node", "dist/index.js"]
