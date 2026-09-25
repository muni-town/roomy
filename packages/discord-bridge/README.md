# @roomy/discord-bridge

Unidirectional Discord → Roomy bridge. Listens to Discord gateway events, persists state in SQLite, and writes to Roomy spaces via the appserver XRPC interface. The bridge never mutates Discord — no channel topics, no marker messages, no webhooks, no role manipulation.

## Architecture

```
Discord Gateway ──► Bot event handlers
                        │
                        ▼
                  ingestDiscordMessage()  ── shared ingestion path
                        │
                  ┌─────┴──────┐
                  │  Dedup via  │
                  │  SQLite     │
                  │  id_mappings│
                  └─────┬──────┘
                        │
                        ▼
                  SpaceManager ──► Appserver (XRPC) ──► Roomy
```

- **Unidirectional**: Discord → Roomy only. No events flow back to Discord.
- **SQLite-backed**: All sync state (ID mappings, cursors, allowlists, profile hashes) lives in a single `bridge.sqlite` file. No LevelDB, no extensions-based dedup.
- **No Discord-side writes**: The bot never sends messages, creates webhooks, edits channel topics, or manages roles. It only reads.
- **Backfill on connect/reconnect**: On every gateway READY event, walks Discord history forward from saved per-channel cursors for each bridged channel.
- **Shared ingestion**: Live messages and backfill use the same `ingestDiscordMessage()` path — identical dedup, room resolution, and event dispatch.

### Directory structure

```
src/
├── index.ts                   # Entry point, gateway wiring, graceful shutdown
├── env.ts                     # Environment variable validation
├── api.ts                     # HTTP API server (/info, /get-guild-id, /get-space-id, /bridges)
├── logger.ts                  # Structured logging
├── db/
│   ├── schema.ts              # SQLite migrations
│   └── repository.ts          # BridgeRepository (all state access)
├── discord/
│   ├── types.ts               # Discordeno property deserialization
│   ├── cache.ts               # Proxy cache extension
│   └── slash-commands.ts      # Slash command registration + handlers
├── roomy/
│   ├── client.ts              # ATProto session + Roomy client init
│   └── space-manager.ts       # Space connection lifecycle (connect/disconnect)
├── services/
│   ├── message-ingestion.ts   # Core message → Roomy event pipeline
│   ├── message-edit-delete.ts # Edit and delete propagation
│   ├── reaction-sync.ts       # Reaction add/remove sync
│   ├── profile-sync.ts        # Discord user profile → updateProfile events
│   ├── room-sync.ts           # Room/sidebar/thread creation + thread handling
│   └── backfill.ts            # History backfill on READY
└── utils/
    ├── hash.ts                # SHA-256 fingerprinting for profile dedup
    └── emoji.ts               # Emoji parsing (unicode + custom)
```

### Synced event types

| Discord event           | Roomy event                     | Notes                                            |
| ----------------------- | ------------------------------- | ------------------------------------------------ |
| MESSAGE_CREATE          | `createMessage.v0`              | Dedup by Discord message ID → Roomy ULID mapping |
| MESSAGE_UPDATE          | `editMessage.v0`                | Skips if no prior mapping exists                 |
| MESSAGE_DELETE          | `deleteMessage.v0`              | Skips if no prior mapping exists                 |
| THREAD_CREATE           | `createRoom` + `createRoomLink` | Thread auto-inherits parent channel's bridge     |
| MESSAGE_REACTION_ADD    | `addBridgedReaction.v0`         |                                                  |
| MESSAGE_REACTION_REMOVE | `removeBridgedReaction.v0`      |                                                  |
| (per-message)           | `updateProfile.v0`              | Hash-based change detection on author profile    |

## Initial structure sync (one-shot)

When a guild is first bridged, its **category structure and channel order** are
mirrored into the space's sidebar: each Discord category becomes a Roomy
sidebar category, and channels are placed in their category **in Discord
`position` order**.

This happens **once**, and never again. The Roomy sidebar belongs to the
space's admins after the import, so a later Discord rename, move, or reorder —
or a new channel — must not stomp their layout. There is deliberately no
ongoing re-sync, no polling loop, and no periodic reconciliation.

**What "once" means, mechanically.** `services/room-sync.ts`'s
`syncInitialStructure` is called only from `runBackfill` — the initial-sync
path (gateway `READY`, `/connect-roomy-space`, `/roomy-backfill`). The live
gateway handlers (`handleChannelCreate`, `handleChannelUpdate`,
`handleThreadCreate`) do **not** call it: those fire on ongoing Discord events,
and a structure write there is exactly the re-sync this design rules out.

`syncInitialStructure` is additionally guarded by a persisted marker in the
bridge's own SQLite DB (`structure_sync`, migration 7), keyed by
`(guild_id, space_did)`:

- `claimStructureSync` inserts the row and returns whether the caller created
  it. Only that caller writes structure; every later call — a reconnect, a
  second backfill, a re-run of the slash command, a process restart — gets
  `false` and sends nothing.
- The claim is written **before** any event is sent, so the sync is
  at-most-once by construction: a crash between claim and write cannot re-apply
  the structure on the next run.
- `applied_at` records that the event was actually sent. A claim with a null
  `applied_at` means the sync failed before (or during) the write — the
  structure is simply absent, and the claim stays set rather than being rolled
  back, because a retry could otherwise apply it twice.
- The one exception, `releaseStructureSync`, runs only on the path that
  provably sent nothing (no bridged channels to place, e.g. the first backfill
  ran before room creation succeeded), so the single initial sync still happens
  once rooms exist.

The guard lives in the bridge's DB rather than as a check against the live
sidebar on purpose: a sidebar check cannot distinguish "not yet synced" from
"an admin has since rearranged it", and would re-apply the structure in the
latter case. Admin edits win — the bridge does not touch the sidebar after the
initial import.

**Merging, not overwriting.** The event is a `space.roomy.space.updateSidebar.v1`
that merges into what's already there: existing categories are preserved and
matched to Discord categories **by name** (Roomy category ids are assigned by
whoever wrote the sidebar, so a name is the only handle the two systems share),
existing children keep their place ahead of the appended Discord channels, and
channels in no Discord category are appended to the first category — where the
client renders orphans in its edit view.

A Discord category is a grouping header, never a bridged room: `type 4` is
excluded from room creation (`CATEGORY_TYPE` in `discord/data.ts`). Likewise
threads are excluded from the structure read, because Discord reports a
thread's `parent_id` as its *channel*, not its category — `parentId` is only a
category on a non-thread channel.

Events carry two extensions:

- `discordMessageOrigin.v0` — debug breadcrumb (snowflake, channelId, guildId). Never read for sync decisions.
- `authorOverride.v0` — content-level puppetting so Roomy renders the Discord author's identity.

## Sidebar repair (`/roomy-repair-sidebar`)

The initial structure sync merges into the sidebar the space already had. For a
space bridged at creation that target is the space's seed sidebar, so the sync
write is the first admin-facing layout. A space that already had an
admin-authored layout when it was first bridged can instead come out with:

- a **duplicate header** — a Discord category whose name differs from an
  existing category only by case, so the by-name match misses and the category
  is appended as a second header for the same group;
- a **duplicate placement** — a channel an admin had moved into another
  category, placed again in its Discord category because placement is decided
  from the channel alone.

Both show up as growth between the write the sync replaced (the *pre-sync
write*) and the write it sent: more categories carrying a name than before,
more placements of a room than before. A category or room the sidebar never had
is not damage — the sync is supposed to add those.

`src/services/sidebar-recovery.ts` classifies a sidebar-write history with pure
functions; `src/services/sidebar-repair.ts` reads the history and can undo the
sync:

```
/roomy-repair-sidebar                          # inspect every space this guild is bridged to
/roomy-repair-sidebar space-id:<did>           # inspect one space
/roomy-repair-sidebar apply:true               # inspect and revert what can be reverted
```

Run it in a guild whose bridge wrote the damaged sidebar. The reply is
ephemeral, and the command reports one block per space:

| Status               | Meaning                                                       |
| -------------------- | ------------------------------------------------------------- |
| `no-sidebar-history` | the space's log holds no sidebar write                        |
| `no-sync-write`      | no sidebar write by the bridge account; nothing to undo       |
| `no-pre-sync-layout` | the bridge's write is the space's first sidebar write         |
| `edited`             | a member wrote the sidebar after the sync — their layout wins |
| `already-recovered`  | the bridge's latest write already restores the pre-sync layout|
| `multi-sync`         | several bridge writes, the latest not a revert — manual review|
| `no-damage`          | the sync merged without duplicating a header or a placement   |
| `restorable`         | the sync's write is the latest change and duplicated something|

`apply:true` writes only for a `restorable` space, and only the layout the sync
replaced: a revert never invents a layout. Every other status is reported and
left alone, including a space whose members have edited the sidebar since the
sync.

The history comes from the space's own stream (`STREAM_NSID`, default
`space.roomy.space.personal.dev`) backfilled over the sync WebSocket as the
bridge account, so the command needs no admin API and no access to the
appserver's database — it reads as a member and writes as the bridge. The read
is confirmed against the space's current sidebar (`getMetadata`) before
anything is written, and again immediately before the write, so a truncated
backfill or a concurrent edit fails closed rather than reverting from a partial
history.

A backfill is not a trustworthy full-log reader on a busy space: the appserver
can drop whole batches while still reporting the backfill drained, and the
frames that did arrive carry no trace of the ones that did not. A read
therefore counts only once a second read of the same space classifies the same
sidebar writes; a space that cannot be read consistently comes back as an
error and is left alone. A backfill that stalls is resumed from the last event
seen, and a read that does not reach the end of the log within two minutes
fails.

## Environment variables

### Required

| Variable                      | Description                                             |
| ----------------------------- | ------------------------------------------------------- |
| `DISCORD_TOKEN`               | Discord bot token                                       |
| `ATPROTO_BRIDGE_DID`          | DID of the ATProto identity the bridge authenticates as |
| `ATPROTO_BRIDGE_APP_PASSWORD` | App password for ATProto authentication                 |
| `APPSERVER_URL`               | Appserver HTTP origin (e.g. `http://127.0.0.1:8080`)    |
| `APPSERVER_DID`               | DID of the appserver service                            |

### Optional

| Variable             | Default                            | Description                                                                      |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| `STREAM_NSID`        | `space.roomy.space.personal.dev`   | Stream NSID                                                                      |
| `STREAM_HANDLE_NSID` | `space.roomy.space.handle.dev`     | Handle NSID                                                                      |
| `BRIDGE_DATA_DIR`    | `./data`                           | Directory for SQLite database                                                    |
| `BRIDGE_DB_PATH`     | `${BRIDGE_DATA_DIR}/bridge.sqlite` | Path to SQLite database                                                          |
| `PORT`               | `3301`                             | HTTP port for bridge API (`/info`, `/get-guild-id`, `/get-space-id`, `/bridges`) |
| `LOG_LEVEL`          | `info`                             | Log level                                                                        |
| `BRIDGE_RECONNECT_BASE_MS` | `5000`                       | Base delay (ms) for the shared reconnect backoff to a failing appserver          |
| `BRIDGE_RECONNECT_MAX_MS`  | `300000`                     | Max delay (ms) cap for the shared reconnect backoff                              |
| `SYSTEM_SPACE`             | *(unset)*                    | Space DID for admin system messages (capacity alerts)                            |
| `SYSTEM_CHANNEL`           | *(unset)*                    | Channel ULID for admin system messages; both must be set to enable               |
| `BRIDGE_CAPACITY_KILL_SWITCH` | `false`                   | `true`/`1` disables per-guild capacity checks globally (emergency re-enable)      |

## Capacity enforcement (Roomy Pro)

Bridged (guild, space) tuples are checked against `space.roomy.admin.getSpaceMembership`, which reports the space's member count vs its token capacity (`maxMembers`). Decisions are cached for 300s per tuple; the bridge re-checks at startup, every 5 minutes, and on `guildMemberAdd`/`guildMemberRemove`.

Two thresholds drive the policy:

- **Over the capacity threshold** (`memberCount > maxMembers`): sync **continues**, but the bridge posts a notice to the admin system channel (`SYSTEM_SPACE`/`SYSTEM_CHANNEL`) — bridging is at risk, not yet paused.
- **Hard stop** (`memberCount >= 2x maxMembers`): ALL sync for the tuple halts (messages, edits, room/thread creation, profile sync, backfill) and the guild owner is DMed. Sync resumes automatically once a later check finds the member count back below 2x capacity.

System messages are sent as the bridge's ATProto account, so that account must be a member of `SYSTEM_SPACE` with write access to `SYSTEM_CHANNEL`. If either env var is unset, notifications are disabled and enforcement proceeds silently.

## Slash commands

All commands require **Administrator** permissions and only work in guilds.

| Command                                                          | Description                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/connect-roomy-space space-id:<did>`                            | Connect a Roomy space to this Discord guild (full mode)                           |
| `/disconnect-roomy-space [space-id:<did>]`                       | Disconnect a bridged space. Omit space-id if only one bridge exists.              |
| `/roomy-status`                                                  | Show all connected bridges and their mode                                         |
| `/roomy-bridge-channel add channel:#channel [space-id:<did>]`    | Add a channel to the allowlist (switches bridge to subset mode if currently full) |
| `/roomy-bridge-channel remove channel:#channel [space-id:<did>]` | Remove a channel from the allowlist. Existing synced messages are preserved.      |
| `/roomy-bridge-channel list [space-id:<did>]`                    | List channels in the allowlist                                                    |
| `/roomy-repair-sidebar [space-id:<did>] [apply:<bool>]`          | Inspect a bridged space's sidebar for structure-sync damage, optionally reverting it |

## Subset mode

Bridges start in **full mode** (all text channels in the guild are synced). Adding a channel via `/roomy-bridge-channel add` switches the bridge to **subset mode** — only explicitly allowlisted channels are synced. Thread children of allowlisted channels are synced automatically.

Channels removed from the allowlist stop receiving new messages; previously synced messages remain in Roomy.

## Deployment

### Docker

The Dockerfile uses a multi-stage Bun build with Litestream for SQLite WAL replication to S3-compatible storage.

```bash
docker build -f packages/discord-bridge/Dockerfile -t roomy-discord-bridge .
```

Required runtime env:

```bash
docker run -d \
  -e DISCORD_TOKEN=... \
  -e ATPROTO_BRIDGE_DID=... \
  -e ATPROTO_BRIDGE_APP_PASSWORD=... \
  -e APPSERVER_URL=... \
  -e APPSERVER_DID=... \
  -e S3_BUCKET=... \
  -e S3_ENDPOINT=... \
  -e S3_REGION=... \
  -e S3_ACCESS_KEY_ID=... \
  -e S3_SECRET_ACCESS_KEY=... \
  -v bridge-data:/data \
  roomy-discord-bridge
```

The entrypoint restores the SQLite database from S3 on first start (if no local DB exists) and wraps the Bun process with Litestream for continuous replication.

### How the image is published, and how to compare merged against running

`ghcr.io/meri-leeworthy/roomy-discord-bridge` is built and published by
[`.github/workflows/discord-bot.yaml`](../../.github/workflows/discord-bot.yaml):
a push to `main` or `next` (or a `v*` tag) runs its single `build-and-publish`
job — checkout → `docker/metadata-action` → Buildx → GHCR login → build and
push from `packages/discord-bridge/Dockerfile`. The metadata action's
`type=ref,event=branch` publishes the branch tag, so a `next` push produces
`ghcr.io/meri-leeworthy/roomy-discord-bridge:next`, alongside `sha-<short>`
tags. The build passes `RAILWAY_GIT_COMMIT_SHA=${{ github.sha }}`, which the
Dockerfile bakes into `BUILD_ID` as the commit's first 8 characters.

**Nothing in this repo advances a running service.** The workflow ends at the
registry push — it has no Railway CLI step, no deploy hook, no `RAILWAY_TOKEN`
and no `railway up` — and the repo carries no service-side config at all (no
`railway.json`/`railway.toml`, no `nixpacks.toml`, no `Procfile`, no root
`Dockerfile`). The published tags and the deployed process are therefore
connected only by configuration that lives outside this repo, and no artifact
here records when that configuration last changed. Which of the two the service
consumes — the published image, or a build of this repo — is likewise not
visible from the repo.

#### The check

The bridge stamps every structured log line with `build_id`: the first 8
characters of the commit it was built from, whether that build came from CI or
from the platform, so the running commit is directly comparable with a merge
([`src/logger.ts`](src/logger.ts) → [`src/telemetry/build.ts`](src/telemetry/build.ts);
a container built with no git metadata reports `unknown`, which names nothing).

```logql
# Grafana / Loki — which builds are logging, in the last 6h:
sum by (build_id) (count_over_time({service_name="discord-bridge"} | json [6h]))
```

```bash
# A container you run yourself:
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' <container> | grep BUILD_ID
```

Because `build_id` is a commit in this repo, `git rev-list --count
<build_id>..origin/next` reads as "commits behind" — the comparison the deploy
path cannot otherwise make for you.

### Local development

```bash
cp .env.example .env
# Fill in DISCORD_TOKEN, ATPROTO_BRIDGE_DID, ATPROTO_BRIDGE_APP_PASSWORD,
# APPSERVER_URL, APPSERVER_DID
bun install
bun run dev       # watch mode
bun run start     # production mode
```

