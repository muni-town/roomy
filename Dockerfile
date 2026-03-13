FROM node:24 AS build

# Extract the first 8 characters of the git commit from railway as the build ID if present
ARG RAILWAY_GIT_COMMIT_SHA
ENV BUILD_ID=${RAILWAY_GIT_COMMIT_SHA%"${RAILWAY_GIT_COMMIT_SHA#??*??????}"}

ARG VITE_LEAF_URL
ENV VITE_LEAF_URL=$VITE_LEAF_URL

ARG VITE_STREAM_NSID
ENV VITE_STREAM_NSID=$VITE_STREAM_NSID

ARG PUBLIC_PDS_INVITE_CODE
ENV PUBLIC_PDS_INVITE_CODE=$PUBLIC_PDS_INVITE_CODE

ARG PUBLIC_PDS
ENV PUBLIC_PDS=$PUBLIC_PDS

ARG PUBLIC_PDS_HANDLE_SUFFIX
ENV PUBLIC_PDS_HANDLE_SUFFIX=$PUBLIC_PDS_HANDLE_SUFFIX

ARG VITE_STREAM_HANDLE_NSID
ENV VITE_STREAM_HANDLE_NSID=$VITE_STREAM_HANDLE_NSID

ARG VITE_FARO_ENDPOINT
ENV VITE_FARO_ENDPOINT=$VITE_FARO_ENDPOINT

ARG OAUTH_HOST
ENV OAUTH_HOST=$OAUTH_HOST

ARG PUBLIC_DISCORD_BRIDGE
ENV PUBLIC_DISCORD_BRIDGE=$PUBLIC_DISCORD_BRIDGE

# Uncomment if building on network with a custom certificate
# COPY ./gitignore/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

COPY . /project
WORKDIR /project
RUN npm i -g pnpm
RUN pnpm i

RUN npx turbo build-web-app-prod

FROM caddy:alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /project/packages/app/build /usr/share/caddy


