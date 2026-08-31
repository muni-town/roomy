# Grafana Alloy — Roomy production log collector

Deploys `grafana/alloy` as a central log collector on Railway. The apps
(appserver, discord-bridge) push structured JSON logs here over the Railway
private network (app-lite ships from the browser via Faro), and Alloy ships
the logs to Grafana Cloud Loki.

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
3. **Networking → Private networking** — add this service to a private
   network so the apps can reach it by name at `alloy:3100`.
4. **Ports**: open `3100` (Loki push API), `12345` (Alloy UI/reload).
   `4317`/`4318` (OTLP) are optional.
5. **Healthcheck**: `/-/healthy` on port `12345`.

> Grafana Cloud: *Your Stack → Details* shows your Loki push URL
> (`logs-prod-<region>.grafana.net`). Create an Access Policy token for the
> password; use the Loki instance ID as the user.

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

## Ports
- `3100`  — Loki push API receiver (`loki.source.api`)
- `12345` — Alloy UI + config reload / healthcheck
- `4317`/`4318` — OTLP gRPC/HTTP logs receiver (optional)
