# Grafana Alloy — Roomy production telemetry collector

Deploys `grafana/alloy` as a central telemetry collector on Railway. The apps
(appserver, discord-bridge) push structured JSON logs here over the Railway
private network (app-lite ships from the browser via Faro); Alloy ships the
logs to Grafana Cloud Loki, forwards traces to Grafana Cloud Tempo, **and**
scrapes the appserver's Prometheus `/metrics` endpoint, remote-writing to
Grafana Cloud Mimir.

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
   | `GRAFANA_CLOUD_TEMPO_URL` | OTLP gateway base URL, e.g. `https://otlp-gateway-prod-<region>.grafana.net/otlp` (the exporter appends `/v1/traces`). Optional: unset → the exporter points at a placeholder and spans are dropped after retry; logs/metrics are unaffected. **Set all three Tempo vars or none** — a URL with placeholder credentials just 401s. |
   | `GRAFANA_CLOUD_TEMPO_ID` | Grafana Cloud instance ID (OTLP basic-auth user). Required *with* `_URL`/`_TOKEN` to ship spans. |
   | `GRAFANA_CLOUD_TEMPO_TOKEN` | Grafana Cloud access policy token (OTLP basic-auth pass). |
   | `APPSERVER_METRICS_URL` | appserver scrape target as **host:port** (no scheme/path). On Railway this must be `<service-name>.railway.internal:8080` — Railway's private DNS uses the `.railway.internal` suffix, so the Dockerfile default `appserver:8080` does **not** resolve there. Short/bare names only work in the dev compose network (where the container is actually named `alloy`/`appserver`). Scheme is http, path is `/metrics`. |
   | `FARO_CORS_ORIGINS` | Comma-separated browser origins allowed to POST Faro telemetry (default `https://roomy.space` — the SPA origin) |
   | `FARO_API_KEY` | Optional Faro API key (default unset) |
3. **Networking → Private networking** — ensure this service is on the
   project's private network so the apps can reach it by name at
   `alloy.railway.internal:3100`. (Railway enables this by default; the
   `.railway.internal` suffix is required — a bare `alloy` will not resolve.)
4. **Ports**: open `3100` (Loki push API), `12345` (Faro receiver),
   `5005` (Alloy UI/reload), `4317`/`4318` (OTLP gRPC/HTTP — logs + traces).
5. **Healthcheck**: `/-/healthy` on port `5005`.

> Grafana Cloud: *Your Stack → Details* shows your Loki push URL
> (`logs-prod-<region>.grafana.net`) and your OTLP gateway endpoint
> (`otlp-gateway-prod-<region>.grafana.net/otlp`). Create an Access Policy
> token for the password; use the instance ID as the user. The same token
> works for Loki, Mimir, and Tempo if the policy grants all three signals.

## Traces

Alloy forwards OTLP traces to Grafana Cloud Tempo (`otelcol.exporter.otlphttp
"tempo"`), authenticated with the stack instance ID + access policy token:

- **appserver** — **instrumented**: exports OTLP/HTTP spans for
  `space.roomy.space.sendEvents`, `space.roomy.room.getMessages` and
  `space.roomy.space.getThreads`, each with child spans for its internal
  phases (e.g. `sendEvents.write`, `getMessages.selectMessages`). Set
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.railway.internal:4318` on the
  appserver service to switch it on; unset, tracing is a strict no-op.
  Log lines from inside a span carry `trace_id`/`span_id` so Grafana can
  pivot log → trace.
- **discord-bridge** — not instrumented: it ships logs only (the SDK's
  `src/otel.ts` tracer is a no-op without a registered provider).
- **app-lite** — the Faro receiver forwards browser traces to Tempo as well,
  but only once `faro.ts` registers `TracingInstrumentation` (it currently
  loads just console + error instrumentation).

To visualise: in Grafana pick the Tempo (traces) data source and search by
service `appserver`, or jump straight from any log line's `trace_id`.

Because Tempo vars are optional, an unconfigured collector still loads and
keeps shipping logs/metrics; spans retry against `127.0.0.1:1` for up to
`max_elapsed_time` (1m) and are then dropped. If spans are silently missing,
check for `Exporting failed` lines in the Alloy UI (`:5005`).

## Metrics

The appserver exposes a Prometheus `/metrics` endpoint (see
`packages/appserver/src/metrics.ts`) with:

- `roomy_xrpc_requests_total` / `roomy_xrpc_request_duration_seconds` — per-endpoint request count + latency histogram
- `roomy_pool_size` / `roomy_pool_worker_pending` — DB pool size + per-worker queue depth (the signal that caught the system-worker N+1)
- `roomy_cache_hits_total` / `roomy_cache_misses_total` / `roomy_cache_evictions_total` / `roomy_cache_size`
- `roomy_embed_pending` / `roomy_embed_in_flight` / `roomy_embed_enriched_null` / `roomy_embed_db_backoff` / `roomy_embed_priority_queue` / `roomy_embed_transient_backoff`
  - `roomy_embed_pending` is the DB `pending_links` backlog — the same number
    `/health/embed` reports as `pending` (both are a `count(*)` on the global
    DB). It is **not** the in-memory queue; that is `roomy_embed_priority_queue`.
    **Alert:** `roomy_embed_pending > 1000` held for 30m.
  - `roomy_embed_transient_backoff` is how many URLs are currently skipped
    inside a transient-retry backoff window. When it approaches
    `roomy_embed_pending` with `roomy_embed_in_flight` at 0, the whole backlog
    is parked and nothing is being enriched — the DB backlog and the in-memory
    gauge disagree.
- `roomy_embed_backlog_stuck` / `roomy_embed_backlog_stuck_since_seconds` /
  `roomy_embed_backlog_stuck_baseline` / `roomy_embed_backlog_stuck_drain_target` /
  `roomy_embed_backlog_stuck_transitions_total`
  - `roomy_embed_backlog_stuck` is 1 when the backlog is non-empty but the
    sweeper is making no progress: it selected nothing (every pending link is
    inside its transient-retry backoff, or the selection is broken), or the
    work it selected settled no rows. `inFlight` 0 and `dbBackoff` 0 in that
    state, so those two gauges cannot express it. **Alert:**
    `roomy_embed_backlog_stuck == 1` for 15m — the backlog is not draining and
    needs intervention.
  - The flag clears only on a genuine drain: `roomy_embed_pending` must fall to
    `roomy_embed_backlog_stuck_baseline - roomy_embed_backlog_stuck_drain_target`
    — a tenth of the backlog the stall was raised on, read once when the flag
    goes up and never re-measured. A stalled backlog still settles dead links
    every cycle, so "a row left `pending_links`" is the normal state of a stuck
    queue and cannot clear the flag: a backlog that holds at or above that line
    stays stalled, however many rows trickle out of it.
  - `roomy_embed_backlog_stuck_transitions_total` counts changes of the flag in
    both directions. A rising rate there with a flat
    `roomy_embed_enriched_ok_total` means the flag is flapping without the
    backlog moving. Read `lastStallCause` / `lastCycle` / `stallBaselineRows` /
    `stallDrainTarget` on `/health/embed` for the measured cause, row counts
    and drain bar of the last stalled cycle.
- `roomy_embed_enriched_ok_total` / `roomy_embed_enriched_definitive_total` /
  `roomy_embed_enriched_transient_total` / `roomy_embed_sweep_cycles_total` /
  `roomy_embed_sweep_throttled_total` — the enrich RATE and its outcome mix
  (counters, primed with a 0 series at startup so they are always present).
  - `roomy_embed_enriched_ok_total` is the success metric: **flat while
    `roomy_embed_sweep_cycles_total` still climbs IS churn** — the sweeper
    spending time and outbound requests resolving nothing. The single
    `roomy_embed_enriched_null` gauge sums a *definitive* no-data settlement
    (the row is deleted, the backlog drains) with a *transient* failure (the
    row stays pending), so "churning and resolving nothing" cannot be told
    apart from "settling dead links" on that series alone.
  - `roomy_embed_enriched_definitive_total` vs
    `roomy_embed_enriched_transient_total` is that split.
  - `roomy_embed_sweep_throttled_total` counts cycles the loop **yielded**
    after: a full batch that produced no `ok`. The loop runs a full batch
    back-to-back only when it resolved something (the latency optimisation for
    freshly-posted links); otherwise it waits one idle-poll interval, so a
    backlog of links that all fail cannot be fetched flat out. Measured
    against a 20,000-link all-failing backlog: 20,000 fetches/min unbounded,
    50/min bounded.
  - **Alert:** `rate(roomy_embed_sweep_cycles_total[5m]) > 0` with
    `rate(roomy_embed_enriched_ok_total[5m]) == 0` for 15m.
- `roomy_search_indexer_queue` / `roomy_search_backfilled` / `roomy_push_queued`
- `roomy_db_timeouts_total` — DB requests that hit the 30s timeout (pool saturation)
- `roomy_process_starts_total` — process boots, incremented once per process
  at startup (`src/fatal.ts`). This is the crash-loop signal: with
  `Restart=always`, a service that cannot boot shows as a rising boot count
  instead of a service that merely looks healthy between restarts.
  **Alert:** `increase(roomy_process_starts_total[10m]) > 3`.

  A fatal exit (uncaught exception / unhandled rejection) is recorded before
  the process dies, as a `level="error"`, `scope="fatal"`, `fatal=true`
  record carrying `kind`, `error_name`, and the error message/stack. Query
  Loki with `{service_name="appserver"} | json | scope="fatal"` to see why a
  process died — without this record a crash-looping process leaves only
  container stdout noise, which is gone once the container goes away.

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
  (`src/telemetry/loki.ts` in both packages). Set `ALLOY_URL` to
  `http://alloy.railway.internal:3100/loki/api/v1/push` (Railway — the
  `.railway.internal` suffix is required). There is **no default in code**:
  unset means stdout only. Every structured log record is batched (500 / 2s)
  and POSTed with stream labels `service_name`, `level`, `scope` (plus
  Railway replica labels when present).
- **app-lite** — ships logs from the browser via Faro, not the
  Alloy collector.

app-lite is a static SPA (no server stdout): set `PUBLIC_FARO_URL` on the
app-lite service to the collector's Faro endpoint — **the path is required**,
e.g. `https://<alloy-domain>.up.railway.app/collect`. The Faro browser agent
POSTs console logs + errors to the `faro.receiver` here. Because app-lite is
built with `adapter-static`, `PUBLIC_FARO_URL` is **inlined at build time**
(see `Dockerfile.app-lite`) — changing it requires a rebuild, and it must be
passed as a build arg/`ARG`, not just a runtime variable. See
`packages/app-lite/src/lib/telemetry/faro.ts`.

> **Faro is the one signal that needs a public domain.** Railway's edge only
> serves 443, so generate a domain for the alloy service and set its
> **target port to 12345** (Settings → Networking → the domain's port). The
> URL is then `https://<that-domain>/collect` with **no explicit port**.
> Logs, metrics, and app OTLP traces all stay on the private network.

## Ports
- `3100`  — Loki push API receiver (`loki.source.api`)
- `12345` — Faro browser telemetry receiver (`faro.receiver "frontend"`)
- `5005`  — Alloy UI + config reload / healthcheck
- `4317`/`4318` — OTLP gRPC/HTTP receiver, logs → Loki and traces → Tempo
