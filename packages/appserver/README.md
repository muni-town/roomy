# Roomy Appserver (a.k.a. AppView)

Mediates access to its own local SQLite event store via the ATProto XRPC interface.

## Development

Most XRPC methods are authenticated by proxying via the PDS. The appserver can be run and used locally but to be accessible to a public PDS, must be tunneled to the public web, e.g. `tailscale funnel 8080`. The tunneled endpoint becomes the DID e.g. `did:web:device.tail12345.ts.net`. These should be set in `.env`. 

The appserver owns its event store locally; no external event-stream server (Leaf) is required as a runtime dependency.

The event log (`roomy-events.sqlite`) is the append-only source of truth, and the read-state DB (`roomy-readstate.sqlite`) holds unread counts that cannot be reconstructed from it. Everything else is derived: the global DB and the per-space views both regenerate from the event log. The Deployment section below lists each DB and its kind.

## Deployment

Deployed on Railway from `Dockerfile.appserver` (build context is the repo root).

### Backup & restore (Litestream → S3)

The container runs several SQLite databases in WAL mode under `/data`, a
Railway persistent volume that survives deploys (see
`docs/plans/per-space-dbs.md` for the per-space split):

| DB | Path | Kind |
|---|---|---|
| event log | `roomy-events.sqlite` | **source of truth** (append-only) |
| read-state | `roomy-readstate.sqlite` | persistent source of truth (unread) |
| global membership | `global.sqlite` | derived (regenerable from event log) |
| per-space views | `spaces/<spaceDid>.sqlite` | derived (re-materialised from event log) |

The Docker entrypoint (`packages/appserver/docker-entrypoint.sh`) restores the
**static** DBs (`roomy-events.sqlite`, `roomy-readstate.sqlite`, `global.sqlite`)
from an S3-compatible bucket via Litestream when no local copy exists, then
runs the app under `litestream replicate` so every WAL change is continuously
copied to the bucket. Replication config lives in
`packages/appserver/litestream.yml`.

The **per-space DBs** (`spaces/*.sqlite`) are deliberately *not* replicated:
they are derived data that regenerate lazily via re-materialisation from the
event log on first access after a restore (litestream also needs static paths,
which can't enumerate an unbounded set of spaces).

Each per-space DB and each shared DB keeps its own query-planner statistics
(`sqlite_stat1`). A space refreshes its own when it is opened and when its
handle is evicted; the boot sweep refreshes every stream and the shared DBs.
Without them a point lookup plans as a scan of that space's whole `stream_id`
partition, which the space's single worker serializes behind everything else it
is serving — and the mis-plan starts well below six figures. See
`docs/per-space-stats.md`.

The DB workers' native-memory caches — the page cache of each open per-space
connection, and the live prepared statements — are bounded and reported.
See `docs/db-memory-bounds.md`.

The `/data` volume persists across deploys, so the DBs (including the
per-space views and their `materialization_cursor`) are not wiped on redeploy.
On boot, an existing valid local DB wins and replication simply continues; a
DB is only restored from S3 when it is absent or corrupt (first deploy, or a
manual reset). This is what makes boot re-materialisation cheap: with the
per-space DBs intact, re-materialisation skips caught-up spaces instead of
rebuilding every space on each deploy.

### Fail-closed restore (data-loss protection)

Because `/data` is a persistent volume, a redeploy with a failed or missing
backup still has its local DBs and does not silently discard data. The
entrypoint still **refuses to start fresh** as a safety net for the case where
a local DB is absent AND no backup can be restored, unless the operator has
explicitly opted in:

- If a local DB exists and is a valid SQLite file, it is used as-is.
- If a local DB is missing (or corrupt), the entrypoint restores it from S3.
- If the restore fails (no backup yet, or S3 unreachable/misconfigured), the
  container **exits with an error** instead of starting fresh.
- For the **very first deploy** (no backup exists yet), set
  `LITESTREAM_ALLOW_FRESH_START=true` to allow a fresh start. Leave it unset
  (or `false`) on all subsequent deploys so a backup failure fails loudly
  rather than wiping data.

### Shadow follower (`ROOMY_SHADOW`)

The image carries the Rust core (`roomy-appserver`) as well as the Bun service.
`ROOMY_SHADOW=1` starts it as a **follower**: it replays the production event log
into a data directory of its own and serves nothing — no XRPC edge, no socket
plane — so enabling it is a restart with a variable set, not a second deploy.
**Unset is the default**, and the container then runs exactly the Bun service.

| Variable | Default | Meaning |
|---|---|---|
| `ROOMY_SHADOW` | unset | `1` starts the follower |
| `ROOMY_DATA_DIR` | `/shadow` | The follower's own data directory |
| `ROOMY_EVENTS_DB` | `$DATA_DIR/roomy-events.sqlite` | The log it replays: the owner's, opened read-only |
| `ROOMY_SPACES` | derived | Not configured by hand — the entrypoint lists `$DATA_DIR/spaces/*.sqlite` and follows every space the owner materialises |
| `ROOMY_OWNERSHIP` | `follower` | Passed by the entrypoint; a container that sets anything else does not start the follower |
| `ROOMY_HEALTH_ADDR` | `127.0.0.1:8089` | The follower's `/health`, on loopback |
| `ALLOY_URL` | — | Required: without it the follower has no telemetry |
| `ROOMY_SHADOW_AS_LIMIT` | `1073741824` | `prlimit --as` for the child (1 GiB) |

**The projection roughly doubles the derived data on the volume.** The follower
materialises its own `spaces/*.sqlite` and `global.sqlite` from the log, so with
`ROOMY_DATA_DIR=/data/shadow` the volume holds a second copy of every per-space
view. The image's `/shadow` default is on the container's writable layer and is
lost on redeploy — fine for a trial, not for a follower that should survive one.

**It runs as `shadow`**, a system uid created in the image that owns only its
data directory, under `nice -n 19`, `ionice -c3` and the address-space limit
above. Before starting it, the entrypoint verifies that uid *cannot* write
`ROOMY_EVENTS_DB` (`test -w` as `shadow` must fail) and refuses to start the
follower if it can. That permission, not the code path, is what keeps a follower
from writing production.

**It is supervised, and it never takes the container down.** The child is
restarted with backoff (1 s doubling to 60 s, reset after a minute of uptime)
when it exits, and `SIGTERM`/`SIGINT` reach both it and the app. Bun starts
immediately whether or not the follower does; a follower that cannot be started
is one log line, not a failed deploy:

```text
[entrypoint] shadow: not starting the follower — ROOMY_SPACES would be empty (/data/spaces holds no *.sqlite), ALLOY_URL is unset (the follower would have no telemetry)
```

**The telemetry values are passed, not inherited.** `ALLOY_URL`, `APP_ENV`,
`BUILD_ID` and `RUST_LOG` go into the child's `env` when they are set, so what the
follower logs with is what the container was told. Startup names the target by host
only — the URL may carry credentials — and says whether the sink exists at all:

```text
[entrypoint] shadow: log sink enabled — alloy.internal:3100 (env staging, build abc1234)
```

Its health, from inside the container:

```bash
docker exec <container> curl -s 127.0.0.1:8089/health
# {"status":"ok","spaces":[{"space":"did:plc:…","cursor":{"idx":…,"ord":…},"lag":0,"leaseHeld":false,"following":true,"holder":"…","lastError":null}],"loki":{"sent":1234,"failed":0,"dropped":0,"retrying":false}}
```

`following: true` with `leaseHeld: false` is the honest pair for a follower: it
is replaying, and it holds no lease, so it cannot stop the owner materialising.

`loki` is the sink accounting for itself: `sent`, `failed` and `dropped` are
cumulative record counts, `retrying` says a failed push is waiting out its backoff. A
sink that delivers nothing looks exactly like one with nothing to say, so this is
where "are the follower's logs arriving" is answerable without Grafana. `null` means
no sink is configured. A failed push also writes one line to container stderr, at
most once a minute, naming the Alloy's host and the status.

### Schema version bumps (blue-green read serving)

When `SPACE_SCHEMA_VERSION` (`src/db/db.ts`) is bumped, every on-disk per-space
DB (`spaces/*.sqlite`) is on a stale schema. The appserver does **not** wipe
them. Instead it serves reads from the old DB while a temp new-schema DB
(`<spaceDid>.sqlite.new`) is rebuilt from the event log in the background, then
atomically swaps it in (`spaceRebuildBegin` → replay → `spaceRebuildCommit`).

- Reads keep serving pre-deploy data during the rebuild — a space never
  appears empty after a schema bump.
- Writes to a rebuilding space are rejected with a retryable `409`
  (`SpaceRematerializing`) and do **not** land in the event log.
- If a rebuild fails, it is aborted and the old DB keeps serving; the next boot
  retries it.

See `docs/plans/blue-green-read-serving.md` for the full design and the
L1/L2/L3 test layers that prove the invariants.

### Setting up the Railway S3 bucket

1. In Railway, create a **Storage** service and add an **S3** bucket.
2. Link the bucket to the appserver service. Railway injects these variables:
   `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`. No other config is needed — Litestream reads them
   from the environment.

Litestream is only active when the app runs in the container. For local
development, run the appserver directly (`bun run packages/appserver/src/index.ts`)
with no backup config.

## Lexicons

`lexicons/` holds the ATProto JSON lexicons this service defines, grouped by
NSID path. The XRPC definitions here are the contract for third-party clients
and are mirrored into the SDK by `packages/sdk/scripts/generate-lexicons.ts`;
pure **record** collections (no query, no procedure — e.g.
`space/roomy/user/profile.json`) are not generated into the SDK and live only
in this directory. Nothing here is served over HTTP: the appserver answers
`/.well-known/did.json` and XRPC, nothing else.

### Publishing a lexicon

A lexicon becomes network-resolvable when it is published as a
`com.atproto.lexicon.schema` record, with the rkey set to the NSID, in the repo
of the NSID's **authority**. `scripts/publish-lexicons.ts` does this.

Whether to publish depends on the lexicon's kind:

- A **permission set** must resolve — an authorizing PDS resolves an `include:`
  scope, and a set that cannot be resolved fails the session. That is why
  `space.roomy.authComplete` is published.
- A **record collection** or XRPC definition does not: the appserver writes the
  collection name as a literal and never resolves the NSID, which is how
  `space.roomy.user.profile` has been read since it shipped. Publishing buys
  third-party resolution — a client, indexer or validator that does not ship
  this source — and nothing at runtime.

Publishing is **out-of-band**: it needs credentials for the account that holds
the repo, which the appserver does not have, and it is not part of the build or
deploy.

#### 1. The authority

Authority comes from DNS, not from the `roomy.space` apex. For an NSID, drop
the name segment, reverse the rest, and look up `_lexicon.<that domain>`. The
lookup is **not hierarchical** — a resolver never falls back to a parent or
child domain — so NSIDs that differ in more than the last segment have
different authorities, and each authority group needs its own TXT record.

| Authority domain | NSIDs it governs | TXT record (2026-10-02) |
| --- | --- | --- |
| `roomy.space` | `space.roomy.authComplete`, `space.roomy.service` | `did=did:plc:cyqufxsezk33hqulcilckna6` |
| `user.roomy.space` | `space.roomy.user.*` | `did=did:plc:cyqufxsezk33hqulcilckna6` |
| `richtext.roomy.space` | `space.roomy.richtext.*` | absent |
| `space.roomy.space` | `space.roomy.space.*` | absent |
| `room.roomy.space` | `space.roomy.room.*` | absent |
| `embed.roomy.space` | `space.roomy.embed.*` | absent |
| `mention.roomy.space` | `space.roomy.mention.*` | absent |

Those are all of them: the missing groups need five TXT records, not one per
NSID. The record is `"did=<did>"` — a single value, since two are ambiguous.
Create them at whichever provider hosts the `roomy.space` zone (Cloudflare).
The DID must have a repo to publish into; `did:plc:cyqufxsezk33hqulcilckna6`
does, and the appserver's own `did:web:api.roomy.space` does not — its DID
document carries an `#atproto` verification key and an appserver service entry,
but no `#atproto_pds`.

`bun run scripts/publish-lexicons.ts <nsid> --dry-run` reports what is missing:

```
space.roomy.richtext.blocks  →  create TXT  _lexicon.richtext.roomy.space  =  "did=<authority-did>"
```

#### 2. The credentials

```
export LEXICON_AUTHORITY_IDENTIFIER=roomy.space     # handle or DID of the authority account
export LEXICON_AUTHORITY_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

An app password is enough — the write authenticates as the authority account
against its own PDS, which the script reads from the DID document
(`LEXICON_AUTHORITY_PDS` overrides).

#### 3. The write

```
bun run scripts/publish-lexicons.ts space.roomy.user.block
# or every lexicon in lexicons/ whose authority already resolves:
bun run scripts/publish-lexicons.ts --all --dry-run
bun run scripts/publish-lexicons.ts --all
```

The script resolves the authority, refuses to guess when there is none, writes
the document verbatim plus `$type: "com.atproto.lexicon.schema"`, and reads it
back to confirm the repo holds what it sent. It writes with `validate: false`:
no PDS knows `com.atproto.lexicon.schema`, so a validating write is rejected.

Verify from outside with any resolver, e.g.
`https://lexicon.garden/xrpc/com.atproto.lexicon.resolveLexicon?nsid=<nsid>`.

**Outstanding:** no `_lexicon.richtext.roomy.space` record exists, so the
lexicons in that group have nowhere to publish yet.
