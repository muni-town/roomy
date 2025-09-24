FROM caddy:alpine

COPY lab.Caddyfile /etc/caddy/Caddyfile
COPY build /usr/share/caddy

