# ── Grafana Alloy (production collector) ────────────────────────────────
#
# Central log collector for Roomy on Railway. Receives logs pushed by
# appserver / discord-bridge and ships them to Grafana Cloud, plus the
# app-lite Faro browser telemetry (faro.receiver on 12345).
#
# Config is baked in (the user can't attach a Railway volume), so the only
# runtime inputs are env vars (see README.md):
#   - GRAFANA_CLOUD_LOKI_ID
#   - GRAFANA_CLOUD_LOKI_TOKEN
#   - GRAFANA_CLOUD_REGION   (optional, default `us`)
#   - FARO_CORS_ORIGINS      (comma-separated browser origins; default below)
#   - FARO_API_KEY           (optional; default empty)
#
# Ports: 5005 (Alloy UI/reload), 3100 (Loki push API), 12345 (Faro),
# 4317/4318 (OTLP).

FROM grafana/alloy:latest

# Build context is the repo root (Railway builds from the repo, not this
# subdir), so reference the config relative to the root.
COPY deploy/alloy/config.alloy /etc/alloy/config.alloy

# Faro receiver defaults — Railway env vars override these at runtime.
# Default origin = the production app (roomy.space, the SPA origin).
ENV FARO_CORS_ORIGINS=https://roomy.space
ENV FARO_API_KEY=

# Appserver Prometheus scrape target (Railway private network). Override on
# Railway if the appserver service has a different name/port.
ENV APPSERVER_METRICS_URL=http://appserver:8080/metrics

# Alloy writes WAL/positions to disk — keep the volume small but writable.
ENV ALLOY_WAL_DIR=/var/lib/alloy

EXPOSE 5005 3100 12345 4317 4318

CMD ["run", "--server.http.listen-addr=0.0.0.0:5005", "/etc/alloy/config.alloy"]
