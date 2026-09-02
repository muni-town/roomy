# Grafana Alloy — Roomy production telemetry collector

Deploys `grafana/alloy` as a central telemetry collector on Railway. The apps
(appserver, discord-bridge) push structured JSON logs here over the Railway
private network (app-lite ships from the browser via Faro); Alloy ships the
logs to Grafana Cloud Loki **and** scrapes the appserver's Prometheus
`/metrics` endpoint, remote-writing to Grafana Cloud Mimir.

The config is **baked into the image** so no Railway volume is required.

## Deploy on Railway

1. **New Project → Deploy from Dockerfile**, pointing at the repo root.
   Set the **Dockerfile path** to `deploy/alloy/Dockerfile`. The build context
   is the repo root, so the config is referenced as `deploy/alloy/config.alloy`.
2. Under the service → **Variables**, set:
   | Variable | Value |
   |---|---|
   | `GRAFANA_CLOUD_LOKI_URL` | `https://logs-prod-<region>.grafana.net/loki/api/v1/push` |
   | `GRAFANA_CLOUD_LOKI_ID` | Grafana Cloud Loki instance ID |
   | `GRAFANA_CLOUD_LOKI_TOKEN` | Grafana Cloud access policy token |
   | `GRAFANA_CLOUD_MIMIR_URL` | `https://prometheus-prod-<region>.grafana.net/api/prom/push` |
   | `GRAFANA_CLOUD_MIMIR_ID` | Grafana Cloud Prometheus instance ID |
   | `GRAFANA_CLOUD_MIMIR_TOKEN` | Grafana Cloud access policy token |
   | `APPSERVER_METRICS_URL` | appserver `/metrics` scrape target (default `http://appserver:8080/metrics`, set in the Dockerfile ENV; override on Railway) |
   | `FARO_CORS_ORIGINS` | Comma-separated browser origins allowed to POST Faro telemetry (default `https://roomy.space` — the SPA origin) |
   | `FARO_API_KEY` | Optional Faro API key (default unset) |
3. **Networking → Private networking** — add this service to a private
   network so the apps can reach it by name at `alloy:3100`.
4. **Ports**: open `3100` (Loki push API), `12345` (Faro receiver),
   `5005` (Alloy UI/reload). `4317`/`4318` (OTLP) are optional.
5. **Healthcheck**: `/-/healthy` on port `5005`.

> Grafana Cloud: *Your Stack → Details* shows your Loki push URL
> (`logs-prod-<region>.grafana.net`). Create an Access Policy token for the
> password; use the Loki instance ID as the user.

## Metrics

The appserver exposes a Prometheus `/metrics` endpoint (see
`packages/appserver/src/metrics.ts`) with:

- `roomy_xrpc_requests_total` / `roomy_xrpc_request_duration_seconds` — per-endpoint request count + latency histogram
- `roomy_pool_size` / `roomy_pool_worker_pending` — DB pool size + per-worker queue depth (the signal that caught the system-worker N+1)
- `roomy_cache_hits_total` / `roomy_cache_misses_total` / `roomy_cache_evictions_total` / `roomy_cache_size`
- `roomy_embed_pending` / `roomy_embed_in_flight` / `roomy_embed_enriched_null` / `roomy_embed_db_backoff`
- `roomy_search_indexer_queue` / `roomy_search_backfilled` / `roomy_push_queued`
- `roomy_db_timeouts_total` — DB requests that hit the 30s timeout (pool saturation)

Alloy scrapes it (`prometheus.scrape "appserver"`) and remote-writes to
Grafana Cloud Mimir. Build Grafana dashboards + alerts on these, e.g. alert
when any `roomy_pool_worker_pending` > threshold or `roomy_db_timeouts_total`
rate > 0.

The appserver also emits a **periodic metrics snapshot** to Loki every 30s
(`[metrics] snapshot` log line) so saturation trends are visible in Grafana
Loki even without a metrics backend.

## How apps forward logs

Apps push structured JSON logs directly to Alloy over the Railway private
network — no stdout pipes or sidecar forwarders.

- **appserver** and **discord-bridge** — each ships an in-app Loki sink
  (`src/telemetry/loki.ts` in both packages). When `ALLOY_URL` is set
  (default `http://alloy:3100/loki/api/v1/push`), every structured log
  record is batched (500 / 2s) and POSTed to the Alloy Loki push API with
  stream labels `service_name`, `level`, `scope` (plus Railway replica
  labels when present). Unset in dev → stdout only.
- **app-lite** — ships logs from the browser via Faro (TASK-66), not the
  Alloy collector.

app-lite is a static SPA (no server stdout): set `PUBLIC_FARO_URL` on the
app-lite service to the collector's Faro endpoint — the path must be
included, e.g. `https://alloy.<railway-domain>.up.railway.app:12345/collect`
(the Faro agent POSTs verbatim to the configured URL; it does NOT append
`/collect`) and the Faro browser agent POSTs console logs + errors to the
`faro.receiver` here. See `packages/app-lite/src/lib/telemetry/faro.ts`.

## Ports
- `3100`  — Loki push API receiver (`loki.source.api`)
- `12345` — Faro browser telemetry receiver (`faro.receiver "frontend"`)
- `5005`  — Alloy UI + config reload / healthcheck
- `4317`/`4318` — OTLP gRPC/HTTP logs receiver (optional)
