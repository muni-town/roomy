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
   | `APPSERVER_METRICS_URL` | appserver scrape target as **host:port** (no scheme/path). On Railway this must be `<service-name>.railway.internal:8080` — Railway's private DNS uses the `.railway.internal` suffix, so the Dockerfile default `appserver:8080` does **not** resolve there. Short/bare names only work in the dev compose network (where the container is actually named `alloy`/`appserver`). Scheme is http, path is `/metrics`. An empty value drops the target (`discovery.relabel`), so the collector scrapes nothing instead of reporting a dead `up == 0` for a deployment that does not exist. |
   | `ALLOY_ENV` | This collector's environment — the `env` label on scraped metrics and on browser records. Default `production`; set it to `staging` on the staging collector. Trimmed and lowercased, and an empty or whitespace-only value counts as unset. |
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

## Environments

Every signal carries `env`. **Logs and traces** carry the application's own
value: a stream label and a field on the JSON line, and the
`deployment.environment.name` resource attribute on spans. The app derives it
from `APP_ENV`, then `RAILWAY_ENVIRONMENT_NAME`, then `unknown`.

**Metrics and browser records** carry the **collector's** environment instead,
from `ALLOY_ENV` (default `production`): `env` is a target label on the scrape
(so a label on every series) and a constant stream label on the Faro path.
Neither signal has an application value to inherit — the collector scrapes a
host it was pointed at, and the SPA is one build serving several deployments,
so the collector's identity is the only thing that knows which environment
produced them. Normalization is the same on both sides (trim; empty or
whitespace-only counts as unset; lowercase), so `env` is one dimension across
all four signals.

It exists so that "which deployment produced this?" is answered by the
telemetry rather than inferred from a Railway service name: without it, two
environments posting to the same Loki tenant merge into one stream, and the
difference is only in the line text — unrecoverable after the fact. `build_id`
stays out of every label position for the opposite reason: one stream (or one
series set) per deploy is never reclaimed.

Staging therefore needs **its own Alloy, in its own Railway project**, with
`ALLOY_ENV=staging` and `APPSERVER_METRICS_URL` pointed at the staging
appserver. The image and the config are shared between the two collectors;
only those two variables differ, which is what keeps staging metrics from
being labelled — or a staging target reported — as production. The
Loki push receiver on port 3100 has no authentication and is reachable only on
the project's private network, so it is per-project by construction — a
staging app pointing at production's collector would be both a telemetry merge
and an open ingest path into the production log store.

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
- **app-lite** — **instrumented**: the browser agent registers console, error,
  session, web-vitals (LCP/CLS/INP/FCP/TTFB) and tracing instrumentation, and
  the Faro receiver forwards the spans to Tempo. Requires `PUBLIC_FARO_URL`
  **and** the Tempo vars above to be set — with `PUBLIC_FARO_URL` unset the
  client loads no telemetry SDK at all; with the Tempo vars unset the receiver
  still accepts the spans and the exporter drops them.

To visualise: in Grafana pick the Tempo (traces) data source and search by
service `appserver` (server spans) or `roomy-app-lite` (browser spans), or jump
straight from any log line's `trace_id`.

Because Tempo vars are optional, an unconfigured collector still loads and
keeps shipping logs/metrics; spans retry against `127.0.0.1:1` for up to
`max_elapsed_time` (1m) and are then dropped. If spans are silently missing,
check for `Exporting failed` lines in the Alloy UI (`:5005`).

## Metrics

The appserver exposes a Prometheus `/metrics` endpoint (see
`packages/appserver/src/metrics.ts`) with:

- `roomy_xrpc_requests_total` / `roomy_xrpc_request_duration_seconds` — per-endpoint request count + latency histogram
  - `endpoint` is decided by the route table, never by the request. A
    path-parameterised route collapses to its prefix
    (`/blob/<did>/<cid>` → `/blob`, `/webhooks/test/<route>` → `/webhooks/test`).
    A label set lives for the life of the process and is re-emitted on every
    scrape, so labelling by raw path retains one series per blob proxied —
    every blob URL a new series, never reclaimed. Registered XRPC nsids are
    kept as-is: they are bounded by the route table, and the per-endpoint split
    is the point of the metric.
  - Everything else folds to one constant: `/other` for a path the appserver
    does not serve (scanner probes such as `/.env`, `/.git/config`), and
    `/other/xrpc` for an `/xrpc/<nsid>` the router does not have. One value
    each, no matter how many distinct paths arrive, so scan traffic cannot grow
    the series count. Per-path attribution stays in the access log.
  - **Alert:** `roomy_xrpc_requests_total{endpoint="/other"}` rising is scan
    traffic, not a route.
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
    sweeper is making no progress it cannot explain: it selected nothing
    *although rows existed that no transient-retry backoff window accounted
    for*, and a re-run of the selection did not return them either — a broken
    selection. `inFlight` 0 and `dbBackoff` 0 in that state, so those two gauges
    cannot express it. **Alert:** `roomy_embed_backlog_stuck == 1` for 15m — the
    backlog is not draining and needs intervention.
  - A backlog whose rows are all inside their backoff windows does **not** set
    the flag: every attempt there is already scheduled, and the queue drains on
    its own as the windows expire (each expiry either settles the row or spends
    one of its bounded attempts; the attempt ceiling settles the last one).
    Waiting fixes it, so it is not an alert. Read
    `roomy_embed_transient_backoff` with `roomy_embed_parked_attempts` to watch
    that schedule instead, and `lastStallCause` / `lastCycle` on
    `/health/embed` for why a cycle that DID latch selected nothing.
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
- `roomy_process_rss_bytes` — resident set size of the appserver process, in
  bytes. This is the figure the host bills as memory; nothing else in the
  service reports it, so a footprint claim that is not backed by this series is
  an inference from a local process, not a measurement of the deployed one.
  Sample it with `max_over_time(roomy_process_rss_bytes[1h])` to see the peak a
  restart reaches, not just the idle value a scrape happens to catch.
- `roomy_db_timeouts_total` — DB requests that hit the 30s timeout (pool saturation)
- `roomy_process_boot_timestamp_seconds` — Unix time at which the running
  process booted (`src/fatal.ts`). The value changes with every restart, so a
  restart is visible on the **first scrape after it happens**:
  **Alert:** `changes(roomy_process_boot_timestamp_seconds[1h]) > 0`.
- `roomy_process_starts_total` — boots counted *within* the running process
  (`1` after a clean boot). Read it as the in-process boot count, **not** as a
  restart signal: the counter is created fresh in each process and incremented
  once, so it reads `1` at every scrape of every boot and
  `increase(roomy_process_starts_total[10m])` is always `0`. Restarts are the
  `roomy_process_boot_timestamp_seconds` signal above; this counter cannot see
  them.

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

The appserver also emits a **periodic metrics snapshot** to Loki every 60s
(`[metrics] snapshot` log line) so saturation trends are visible in Grafana
Loki even without a metrics backend. The period matches the Alloy scrape's
default interval, since the line is a fallback for the same numbers —
sampling it faster than the scrape it stands in for buys no resolution, only
Loki ingest.

## How apps forward logs

Apps push structured JSON logs directly to Alloy over the Railway private
network — no stdout pipes or sidecar forwarders.

- **appserver** and **discord-bridge** — each ships an in-app Loki sink
  (`src/telemetry/loki.ts` in both packages). Set `ALLOY_URL` to
  `http://alloy.railway.internal:3100/loki/api/v1/push` (Railway — the
  `.railway.internal` suffix is required). There is **no default in code**:
  unset means stdout only. Every structured log record is batched (500 / 2s)
  and POSTed with stream labels `service_name`, `level`, `scope`, `env` (plus
  Railway replica labels when present).
- **app-lite** — ships logs from the browser via Faro, not the
  Alloy collector.

app-lite is a static SPA (no server stdout): set `PUBLIC_FARO_URL` on the
app-lite service to the collector's Faro endpoint — **the path is required**,
e.g. `https://<alloy-domain>.up.railway.app/collect`. The Faro browser agent
POSTs console logs, errors, web-vitals measurements and spans to the
`faro.receiver` here. Because app-lite is built with `adapter-static`,
`PUBLIC_FARO_URL` is **inlined at build time**
(see `Dockerfile.app-lite`) — changing it requires a rebuild, and it must be
passed as a build arg/`ARG`, not just a runtime variable. See
`packages/app-lite/src/lib/telemetry/faro.ts`.

Set `PUBLIC_ANALYTICS_SALT` on the same service to attribute telemetry to a
user. Signals carry `meta.user.id` as `sha256(salt + ":" + did)` rather than
the DID, so the log store never holds a durable identifier. It is **also
inlined at build time**, so a change needs a rebuild; unlike `PUBLIC_FARO_URL`
it must stay the **same value across a deployment's builds**, since it is what
hashes one user to the same pseudonym across releases — rotating it re-counts
every existing user as new. Unset means no user id is attached and every
session stays anonymous (sessions are still tracked, by session id).
`packages/app-lite/src/lib/telemetry/scrub.ts` owns the mapping.

Each signal also carries `meta.session.id` (`SessionInstrumentation`). One
session spans reloads via the SDK's sticky-session store, so a visit is one
session across a reload; time-in-app is read as first→last signal per session
id, since Faro emits no session-end signal.

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
