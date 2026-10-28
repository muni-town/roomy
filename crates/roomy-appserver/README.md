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
| `ROOMY_SPACES` | — | Comma-separated space DIDs this process owns |
| `ROOMY_TICKET_SECRET` | — | Required by the gateway role; signs connection tickets |
| `ROOMY_TICKET_TTL` | `60` | A ticket's lifetime in seconds |
| `ROOMY_TICKET_AUDIENCE` | `roomy-gateway` | The audience a ticket is bound to |
| `ROOMY_TEST_MODE` | — | `true` accepts `X-Test-Did` instead of a real session |
| `ROOMY_MAX_OPEN_SPACES` | `256` | How many per-space databases the registry keeps open |
| `ROOMY_OWNERSHIP` | `owner` | `follower` replays beside the owner and takes no lease |
| `ROOMY_INTERNAL_SECRET` | — | Enables `/internal/feed` and `/internal/signal` on a gateway |
| `ROOMY_FEED_URL` | — | A worker's feed: the gateway that owns the log |
| `ROOMY_SIGNAL_URL` | — | A worker's signal relay: the gateway that serves the sockets |
| `ROOMY_TS_ORIGIN` | — | The TypeScript appserver. Set, and spaces not cut over are proxied to it |
| `ROOMY_SHADOW_PERCENT` | `0` | How many eligible reads are mirrored to it for comparison |
| `ALLOY_URL` | — | The Alloy Loki push URL (`http://<alloy>:3100/loki/api/v1/push`). Unset: stdout only |
| `APP_ENV` | — | The `env` log label; falls back to `RAILWAY_ENVIRONMENT_NAME`, then `unknown` |
| `BUILD_ID` | `unknown` | The `build_id` field of every log line (the image bakes the commit into it) |
| `RUST_LOG` | `info` | Which events exist at all: the filter both log destinations share |

`ROOMY_FEED_URL` and `ROOMY_SIGNAL_URL` are for the worker role; a gateway reads the
log it owns and fans signals out locally.

A path variable that is set but blank counts as unset, so a template that renders
an empty value falls through to the default.

## Logs

Two destinations, one set of events. The `fmt` layer writes a line to stdout, which
is what `docker logs` shows; when `ALLOY_URL` is set the Loki layer pushes the same
events to Alloy in process — the container's stdout is not collected into Grafana, so
without the second destination a deployed process is invisible there.

The Loki stream carries `service_name` (`space-worker`), `env`, `level` and `scope`,
and the line is one JSON object:

```json
{"ts":"2026-10-27T12:00:00.000Z","level":"info","scope":"materialise","msg":"applied","idx":42,"build_id":"abc1234"}
```

`scope` is a fixed set — `startup`, `materialise`, `feed`, `lease`, `signal`,
`gateway`, `other` — folded from the event's target, so it is a label value and not a
module path. `build_id` is in the line and not in the labels: a label that changes on
every deploy splits the stream once per release.

The sink is bounded (10 000 records, oldest dropped) and batches (500 records or two
seconds). A failed push is retried with exponential backoff from one second to one
minute; every error is swallowed, so a dead Alloy loses log lines and nothing else.
On ctrl-c the queue gets five seconds to drain.

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
| `GET /health` | Sessions held and signal subscribers (the gateway); with `ROOMY_HEALTH_ADDR`, each space's cursor, lag, lease and `following` (a supervisor) |
| `GET /metrics` | Prometheus counters, including the shadow's comparison and divergence counts |
| `POST /xrpc/space.roomy.auth.getConnectionTicket` | A signed, single-use ticket for the socket plane |
| `GET /xrpc/space.roomy.sync.subscribe` | The WebSocket |
| `POST /xrpc/space.roomy.space.sendEvents` | The write ingress |
| `POST /xrpc/space.roomy.room.updateSeen` | Read state |
| `GET /xrpc/{nsid}` | The per-space reads, and the four cross-space fan-outs |
| `GET /internal/feed/{space}` | **Internal.** The log, after a cursor, for a remote worker |
| `POST /internal/signal` | **Internal.** A worker's post-commit signal |

The internal routes require `x-roomy-internal: <ROOMY_INTERNAL_SECRET>` and are not
part of the XRPC surface. Do not expose them at the edge.

## Cutting a space over

Cutover is per space and reversible on the next request. The ownership table is
`materialisation_owners` in the global database: one row per space, a `node`, and a
`revision` that every flip increments.

1. **Set `ROOMY_TS_ORIGIN` on the gateway.** Every space is now proxied to the
   TypeScript appserver — status, headers and body verbatim — except spaces whose
   ownership row names `rust-core`.
2. **Materialise the space here.** Run the workers with `ROOMY_SPACES` including it,
   or start a follower with `ROOMY_HEALTH_ADDR` set. Wait until the space's
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
