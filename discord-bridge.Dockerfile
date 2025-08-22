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
ENV JAZZ_WORKER_ACCOUNT=""
ENV JAZZ_WORKER_SECRET=""
ENV JAZZ_EMAIL=""
ENV DISCORD_TOKEN=""
ENV DATA_DIR="/data"

ENTRYPOINT ["node", "dist/index.js"]