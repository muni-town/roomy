# The Rust core appserver: running it, and cutting over to it

`roomy-appserver` is one binary with two halves. It serves the XRPC edge (reads,
procedures, the socket plane) and it materialises spaces from the event log. Which
halves run in a process is a flag; which spaces a process owns is a lease.

The design, the milestones and the correctness programme are in
`packages/appserver/docs/plans/rust-core-appserver.md`. This file is the operator's
half: what to set, what to watch, what to do when a number goes wrong, and what has
to be true before the TypeScript appserver can be switched off.

## Roles

```text
roomy-appserver --role all        # the default: a gateway and its workers in one process
roomy-appserver --role gateway    # the edge only: reads, procedures, sockets
roomy-appserver --role worker     # spaces only: materialise, serve nothing
```

A gateway without workers serves reads from whatever projections exist on its
machine. A worker without a gateway materialises and tells nobody; it is useful only
when its signals are relayed to a gateway (below).

## Configuration

Every variable has a default that runs the embedded mode against a local data
directory.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROOMY_DATA_DIR` | `data` | Where this process's `spaces/` and `global.sqlite` live |
| `ROOMY_EVENTS_DB` | `<ROOMY_DATA_DIR>/roomy-events.sqlite` | The event log this process reads. Set it to the owner's log to replay production without writing into its directory |
| `ROOMY_HEALTH_ADDR` | — | Where the supervisor serves `/health`, for the `worker` and `all` roles. Unset binds nothing; the `gateway` role serves its own and ignores it |
| `ROOMY_HTTP_ADDR` | `127.0.0.1:8080` | The gateway's listener |
| `ROOMY_SPACES` | — | A narrowing filter: comma-separated space DIDs. Unset or empty, a follower materialises every stream the log holds, including spaces added after it started. Set, it materialises only those spaces |
| `ROOMY_TICKET_SECRET` | — | Required by the gateway role; signs connection tickets |
| `ROOMY_TICKET_TTL` | `60` | A ticket's lifetime in seconds |
| `ROOMY_TICKET_AUDIENCE` | `roomy-gateway` | The audience a ticket is bound to |
| `ROOMY_TEST_MODE` | — | `true` accepts `X-Test-Did` instead of a real session |
| `ROOMY_SERVER_DID` | — | The DID session tokens must name as their audience. Required when the gateway verifies session tokens, which is every deployment that is not in test mode and does not set all three of `ROOMY_GATEWAY_DID`, `ROOMY_WORKER_DID`, `ROOMY_GATEWAY_JWK` |
| `ROOMY_GATEWAY_DID` | — | A split deployment's gateway DID: the issuer its service tokens must carry |
| `ROOMY_WORKER_DID` | — | A split deployment's worker DID: the audience those tokens must name |
| `ROOMY_GATEWAY_JWK` | — | A split deployment's gateway public key (a JWK), the only key that signs those tokens |
| `ROOMY_MAX_OPEN_SPACES` | `256` | How many per-space databases the registry keeps open |
| `ROOMY_OWNERSHIP` | `owner` | `follower` replays beside the owner and takes no lease. A follower derives its spaces from the log: it asks the feed every minute and starts an actor for each stream it is not running |
| `ROOMY_DISCOVERY_INTERVAL` | `60` | How often, in seconds, a follower asks the log which streams it holds |
| `ROOMY_INTERNAL_SECRET` | — | Enables `/internal/feed`, `/internal/streams` and `/internal/signal` on a gateway |
| `ROOMY_FEED_URL` | — | A worker's feed: the gateway that owns the log |
| `ROOMY_SIGNAL_URL` | — | A worker's signal relay: the gateway that serves the sockets |
| `ROOMY_TS_ORIGIN` | — | The TypeScript appserver. Set, and spaces not cut over are proxied to it |
| `ROOMY_SHADOW_PERCENT` | `0` | How many eligible reads are mirrored to it for comparison |
| `ALLOY_URL` | — | The Alloy Loki push URL (`http://<alloy>:3100/loki/api/v1/push`). Unset: stdout only; not an absolute http(s) URL: no sink, and one line saying so |
| `ROOMY_SERVICE_NAME` | `space-worker` | The Loki `service_name` label. A second deployment of this binary sets it, or its lines merge into the first one's stream |
| `APP_ENV` | — | The `env` log label; falls back to `RAILWAY_ENVIRONMENT_NAME`, then `unknown` |
| `BUILD_ID` | `unknown` | The `build_id` field of every log line (the image bakes the commit into it) |
| `RUST_LOG` | `info` | Which events exist at all: the filter both log destinations share |

`ROOMY_FEED_URL` and `ROOMY_SIGNAL_URL` are for the worker role; a gateway reads the
log it owns and fans signals out locally.

### How a caller is authenticated

Three verifiers, chosen by configuration and nothing else:

| Configuration | Verifies |
| --- | --- |
| `ROOMY_TEST_MODE=true` | the `X-Test-Did` header, and nothing else. Test harnesses only |
| all three of `ROOMY_GATEWAY_DID`, `ROOMY_WORKER_DID`, `ROOMY_GATEWAY_JWK` | the service token the gateway in front mints per request (`iss` = the gateway, `aud` = this worker) |
| otherwise | the ATProto session token a client obtains from its PDS |

Test mode wins over everything, so a harness never reaches the network. A set-but-blank
variable counts as unset, so a template that renders an empty value falls through to the
next row of the table.

A session token is verified the way the TypeScript appserver verifies one: an ES256K
signature over the token against the `#atproto` signing key in the issuer's DID document
(resolved over the network and cached, then fetched again once if the signature does not
verify, so a rotated key is honoured), `aud` equal to `ROOMY_SERVER_DID`, `exp` in the
future, and `lxm` — when present — equal to the NSID being called. The caller is `sub`
when the token carries one, which is a PDS-issued token for a user, and `iss` otherwise,
which is an atproto-proxy token signed by the user's own key. **Any failure is an
anonymous caller, never a 401**: the handlers decide what anonymous may read, and a
request that carries no `Authorization` header at all is the same anonymous caller.

### Who decides which spaces a process materialises

An **owner** is told: it materialises the spaces in `ROOMY_SPACES` and no others,
because a space it was not given is one it has no reason to hold. A lease, not this
list, decides which of those the process *writes* — the list says which rows to
compete for, and a process that loses the lease on a space still cannot write it.

A **follower** reads its set from the log (`ROOMY_OWNERSHIP=follower`). At boot,
and every `ROOMY_DISCOVERY_INTERVAL` seconds after, it asks the feed which streams
exist and starts an actor for each one it is not already running. A space written
after it booted is picked up on the next pass, and the pass that starts it writes
one line naming it. The loop never stops an actor, and a stream the feed names but
holds no rows for is reported as `noEvents` in `/health` rather than opened. Setting
`ROOMY_SPACES` on a follower narrows it to the spaces named, which is what a
deployment that wants a bounded replay uses.

A path variable that is set but blank counts as unset, so a template that renders
an empty value falls through to the default.

## Deploying on Railway

The image is `Dockerfile.rust-appserver`: a two-stage build whose runtime is
`debian:bookworm-slim` with `ca-certificates` and `sqlite3`, a release binary at
`/usr/local/bin/roomy-appserver`, and an unprivileged user that owns `/data`.
`crates/roomy-appserver/docker-entrypoint.sh` runs as the entrypoint; the default
command is `--role all`. The entrypoint starts as root only to give the data
directory to that user — a volume mounted at `/data` arrives owned by root and
would otherwise leave the process unable to create `/data/spaces` — and the
binary itself runs as `roomy`, never as root.

| Variable | Set it to | Why |
| --- | --- | --- |
| `ROOMY_DATA_DIR` | `/data` | Where the per-space databases, `global.sqlite` and the event log live. Mount the volume here, or every deploy starts from nothing |
| `PORT` | the platform's port | Railway routes the service's public address to it. The entrypoint turns it into `ROOMY_HTTP_ADDR=0.0.0.0:$PORT`; set `ROOMY_HTTP_ADDR` itself to override |
| `ROOMY_TICKET_SECRET` | a long random string | Signs connection tickets. The gateway role exits 2 without it |
| `ROOMY_SERVER_DID` | the DID clients address this service by | The audience a session token must name. Required, and the process exits without it, unless `ROOMY_TEST_MODE=true` or the split deployment's three variables are set |
| `ROOMY_TEST_MODE` | `true` | Accepts `X-Test-Did` and no other credential, which is the alternative to `ROOMY_SERVER_DID`. See the paragraph on authentication below |
| `ROOMY_SPACES` | comma-separated space DIDs | An owner materialises these and no others |
| `ROOMY_OWNERSHIP` | `owner` (default) or `follower` | `owner` takes leases and writes; `follower` replays beside an owner without taking one |
| `ROOMY_SERVICE_NAME` | `rust-appserver` | The Loki `service_name`. Without it this service writes into the space worker's stream and the two cannot be told apart |
| `APP_ENV` | `staging` | The `env` log label, and the Grafana variable that selects these lines |
| `ALLOY_URL` | the staging Alloy push URL | Unset, the process logs to stdout only, which is not collected into Grafana |

**The owner and the space list.** A Railway service runs `--role all`, so it is a
gateway and its own workers, and its ownership is `owner` unless told otherwise. An
owner materialises the spaces it is given: it never discovers a space the log holds,
because discovery belongs to a follower. On a restored log — or one written by
another process and mounted into this service — an owner with no `ROOMY_SPACES` opens
nothing, so a read for any of those spaces has no projection to answer from while
`/health` still answers 200. The entrypoint closes that gap: when `ROOMY_SPACES` is
unset and the event log exists, it reads `select did from dids` from it, joins the
rows with commas and prints the count. A log that is absent, has no `dids` table, or
holds no rows leaves the variable unset and says so — the container starts either way.

`ROOMY_OWNERSHIP=follower` inverts the rule: the process reads its set from the log
and starts an actor for each stream it finds, so it needs no space list and picks up
spaces added while it runs. That is the shape to use when this service is meant to
replay beside a live owner rather than be one.

**Authentication.** Three verifiers, chosen in this order. `ROOMY_TEST_MODE=true` is
the harness path: the only credential understood is `X-Test-Did`, so anything that
can set that header can drive the process and nothing else can. Otherwise a
deployment that sets all of `ROOMY_GATEWAY_DID`, `ROOMY_WORKER_DID` and
`ROOMY_GATEWAY_JWK` verifies the service tokens its own gateway mints. Otherwise the
process verifies ATProto session tokens as a real client sends them — a bearer token
from `com.atproto.server.getServiceAuth`, checked against the issuer's DID document,
`aud`, `exp` and `lxm` — and **refuses to start without `ROOMY_SERVER_DID`**, the DID
that token's audience must name. A Railway service therefore runs either with
`ROOMY_TEST_MODE=true`, or with `ROOMY_SERVER_DID` set to the DID clients address it
by. A request that fails verification is treated as anonymous rather than rejected:
the handlers make the access decision.

**Health and metrics.** The gateway serves `GET /health` on `ROOMY_HTTP_ADDR`, which
is the path the platform's healthcheck polls; it reports the sessions held and the
signal subscribers. `GET /metrics` is the Prometheus text the staging Alloy scrapes:
point the scrape target at `http://<service>:<port>/metrics` alongside the
TypeScript appserver's, so the two are separable in Grafana by `service`.

`ROOMY_EVENTS_DB` is worth setting when the log lives anywhere other than
`$ROOMY_DATA_DIR/roomy-events.sqlite`; the entrypoint reads the same path it passes
to the binary.

## Logs

Two destinations, one set of events. The `fmt` layer writes a line to stdout, which
is what `docker logs` shows; when `ALLOY_URL` is set the Loki layer pushes the same
events to Alloy in process — the container's stdout is not collected into Grafana, so
without the second destination a deployed process is invisible there.

The Loki stream carries `service_name` (`space-worker`, or whatever
`ROOMY_SERVICE_NAME` names), `env`, `level` and `scope`, and the line is one JSON
object:

```json
{"ts":"2026-10-27T12:00:00.000Z","level":"info","scope":"materialise","msg":"applied","idx":42,"build_id":"abc1234"}
```

`scope` is a fixed set — `startup`, `materialise`, `feed`, `lease`, `signal`,
`gateway`, `other` — folded from the event's target, so it is a label value and not a
module path. `build_id` is in the line and not in the labels: a label that changes on
every deploy splits the stream once per release.

`service_name` is the one label that separates two deployments of this binary in
Grafana, and it is read once at startup: two processes sharing it — a follower and
a service of its own, say — write one stream, and neither can be selected without
the other.

`ALLOY_URL` is checked once at startup. Unset (or blank) is no sink at all; set but
not an absolute http(s) URL is no sink either, and one line says why — a sink that
can never deliver looks from the inside exactly like one with nothing to say:

```
[loki] log sink disabled — ALLOY_URL is not an absolute URL (scheme is "alloy.internal", not http or https)
```

The sink is bounded (10 000 records, oldest dropped) and batches (500 records or two
seconds). A failed push is retried with exponential backoff from one second to one
minute; every error is swallowed, so a dead Alloy loses log lines and nothing else.
On ctrl-c the queue gets five seconds to drain.

Swallowed is not silent. The first event of a process is a `tracing::info!` line that
goes through the same queue and the same push as everything else, so its arrival is
the answer to "are the logs arriving" without waiting for a warning:

```json
{"ts":"2026-10-27T12:00:00.000Z","level":"info","scope":"startup","msg":"startup","spaces":12,"sink":"alloy.internal:3100","build_id":"abc1234"}
```

A push that fails writes one line to stderr — the container log `docker logs` shows.
It names the failure's class, the Alloy's host, and the transport's own account of
what went wrong, with the URL replaced by that host and never the URL itself (it may
carry a token in its path or query):

```
[loki] push to alloy.internal:3100 failed (connect): error sending request for url (alloy.internal:3100): client error (Connect): tcp connect error: Connection refused (os error 111); retrying — logs are not reaching Loki
```

The class is one of `timeout`, `connect`, `redirect`, `response` (body or decode),
`request` (failed while being sent), `builder` (the request never left) or `status`
(Alloy answered). A failure no flag names prints the flags that would have named it,
so the next occurrence needs no rerun to be classified:

```
[loki] push to alloy.internal:3100 failed (unknown timeout=false connect=false request=true builder=false redirect=false): …; retrying — logs are not reaching Loki
```

The first failure of an unhealthy period is announced, the same failure again at most
once a minute, and a recovery once:

```
[loki] push to alloy.internal:3100 recovered; logs are reaching Loki again
```

The counters behind it are on `/health` under `loki` (`sent`, `failed`, `dropped`,
`retrying`), so "are the follower's logs arriving" is a question the process answers
about itself.

A space whose step fails is not retried immediately: the actor waits 250 ms, then
doubles to 30 s, and resets on the next applied batch. A space that cannot make
progress therefore costs neither a core nor a log flood, and its warning names the
space, the cursor it is stuck at, and the error.

## The three deployment shapes

**Embedded.** One process, `--role all`. Workers and sockets share a signal sink.
This is the default and not a toy: the split shapes use the same seams.

**Split.** A gateway with `ROOMY_INTERNAL_SECRET`, and workers with
`ROOMY_FEED_URL` and `ROOMY_SIGNAL_URL` pointing at it. Workers read the log over
HTTP and relay their signals back; nothing else crosses the boundary. The lease
lives in the shared global database, so every worker must be able to reach it.

**Replicated reads.** A process with `--role worker`, `ROOMY_OWNERSHIP=follower`,
its own `ROOMY_DATA_DIR`, `ROOMY_EVENTS_DB` naming the owner's log (on the same
machine, opened read-only), and `ROOMY_HEALTH_ADDR` so the follower is
observable. It replays beside the owner without taking the lease and serves reads
from its own projection, which the gateway in that process mounts unchanged. Its
`global.sqlite` is its own copy — never the owner's, because the owner is that
file's writer.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Sessions held and signal subscribers (the gateway); with `ROOMY_HEALTH_ADDR`, each space's cursor, lag, lease and `following`, and the log sink's counters (a supervisor) |
| `GET /metrics` | Prometheus counters, including the shadow's comparison and divergence counts |
| `POST /xrpc/space.roomy.auth.getConnectionTicket` | A signed, single-use ticket for the socket plane |
| `GET /xrpc/space.roomy.sync.subscribe` | The WebSocket |
| `POST /xrpc/space.roomy.space.sendEvents` | The write ingress |
| `POST /xrpc/space.roomy.room.updateSeen` | Read state |
| `GET /xrpc/{nsid}` | The per-space reads, and the four cross-space fan-outs |
| `GET /internal/feed/{space}` | **Internal.** The log, after a cursor, for a remote worker |
| `POST /internal/signal` | **Internal.** A worker's post-commit signal |
| `GET /internal/streams` | **Internal.** The spaces the log holds, for a worker that derives its own set |

The internal routes require `x-roomy-internal: <ROOMY_INTERNAL_SECRET>` and are not
part of the XRPC surface. Do not expose them at the edge.

## Cutting a space over

Cutover is per space and reversible on the next request. The ownership table is
`materialisation_owners` in the global database: one row per space, a `node`, and a
`revision` that every flip increments.

1. **Set `ROOMY_TS_ORIGIN` on the gateway.** Every space is now proxied to the
   TypeScript appserver — status, headers and body verbatim — except spaces whose
   ownership row names `rust-core`.
2. **Materialise the space here.** Start a follower with `ROOMY_OWNERSHIP=follower`
   — it discovers the space from the log on its next pass — or run the workers with
   `ROOMY_SPACES` including it. Wait until the space's
   `/health` row reports `lag: 0` and a `cursor.idx` equal to the log's last
   index — `select max(idx) from record_changes where stream_id = '<space>'`.
3. **Shadow.** Set `ROOMY_SHADOW_PERCENT` above zero and let it run. Watch
   `roomy_cutover_shadow_comparisons` rise. `roomy_cutover_shadow_alerting_nsids`
   must stay zero: one NSID in it means the two paths answered differently for that
   NSID at least once, and a space is not ready while one stands.
4. **Flip.** Write the ownership row for the space with `node = 'rust-core'`. The
   next request for that space is answered here. Reads and writes move together:
   the same row decides both.
5. **Roll back if it goes wrong.** Flip the row back to the TypeScript appserver's
   node name. The next request is proxied there again. Nothing else changes: the
   Rust projection stays, the cursor stays, and flipping forward again resumes from
   it.

## What to watch

| Signal | Meaning | What to do |
| --- | --- | --- |
| `roomy_cutover_shadow_alerting_nsids` > 0 | A cut-over space's answers differ from the oracle | Roll that space back and read the divergence log |
| `roomy_gateway_proxied` rising after a cutover | Requests for a space that should be ours are still going upstream | Check the ownership row and the request's `spaceId`/entity resolution |
| `roomy_gateway_signals_received` flat while workers are busy | Signals are not arriving: sockets are only as fresh as their TTL | Check the relay URL and the internal secret |
| Worker log `a signal did not reach the gateway` | The relay dropped a signal (advisory, so the read is still correct) | Check the gateway's availability; nothing is corrupted |
| `worker_fence` advancing unexpectedly | A lease changed hands — a restart, an expiry, or two owners | Compare `worker_leases.holder` with the process that thinks it owns the space |

A space's `worker_leases` row names its writer. Two processes believing they own one
space is the failure the fencing epoch exists to make harmless: only the newer epoch
commits.

## Budgets

`cargo test -p roomy-appserver --test budgets -- --ignored --nocapture` measures a
read, a cold rebuild and a page's row count on the fixture corpus, and fails if they
exceed the budgets at the top of that file. Run it on the machine that will serve the
traffic; a timing budget on shared CI hardware measures the hardware.

On the reference workstation the fixture reads at p50 ≈ 1.2 ms and p95 ≈ 4.5 ms, and
a cold rebuild takes ≈ 105 ms.

## Before the TypeScript core is deleted

The parity work is done — projection, reads, writes and the distributed invariants
all have oracles (`packages/appserver/docs/plans/rust-core-appserver.md` §6.3). What
remains is operational, and none of it can be closed from a test suite:

- [ ] **Shadow in production.** `ROOMY_SHADOW_PERCENT` above zero against real
      traffic for every read NSID, with no divergences for a full week.
- [ ] **Every space cut over**, with at least one deliberate rollback exercised on a
      non-critical space and recorded here.
- [ ] **Writes cut over** the same way: the write flag moves per space, and the
      TypeScript writer is stopped before the Rust one is trusted alone.
- [ ] **Chaos under load** (L9): `kill -9` mid-batch, lease expiry mid-write, a
      corrupt per-space database rebuilt from the log, and a gateway lost while
      clients are connected.
- [ ] **The socket plane in production** (L6): reconnect, backfill and slow-consumer
      behaviour against real clients.
- [ ] **Search and push are not ported** (§10). They stay in the TypeScript service
      or move elsewhere; deleting that service means deciding where they go.
- [ ] **The schema moves with the code.** The Rust crates `include_str!` the schema
      from `packages/appserver/src/db/`. Copy or generate it before the package is
      deleted.
