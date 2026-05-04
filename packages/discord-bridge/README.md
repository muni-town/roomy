# @roomy/discord-bridge

Unidirectional Discord → Roomy bridge. Listens to Discord gateway events, persists state in SQLite, and writes to Roomy spaces via the Leaf client. The bridge never mutates Discord — no channel topics, no marker messages, no webhooks, no role manipulation.

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
                  SpaceManager ──► Leaf client ──► Roomy
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
│   ├── client.ts              # ATProto session + Leaf client init
│   └── space-manager.ts       # ConnectedSpace lifecycle (connect/disconnect)
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

| Discord event | Roomy event | Notes |
|---|---|---|
| MESSAGE_CREATE | `createMessage.v0` | Dedup by Discord message ID → Roomy ULID mapping |
| MESSAGE_UPDATE | `editMessage.v0` | Skips if no prior mapping exists |
| MESSAGE_DELETE | `deleteMessage.v0` | Skips if no prior mapping exists |
| THREAD_CREATE | `createRoom` + `createRoomLink` | Thread auto-inherits parent channel's bridge |
| MESSAGE_REACTION_ADD | `addBridgedReaction.v0` | |
| MESSAGE_REACTION_REMOVE | `removeBridgedReaction.v0` | |
| (per-message) | `updateProfile.v0` | Hash-based change detection on author profile |

Events carry two extensions:
- `discordMessageOrigin.v0` — debug breadcrumb (snowflake, channelId, guildId). Never read for sync decisions.
- `authorOverride.v0` — content-level puppetting so Roomy renders the Discord author's identity.

## Environment variables

### Required

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `ATPROTO_BRIDGE_DID` | DID of the ATProto identity the bridge authenticates as |
| `ATPROTO_BRIDGE_APP_PASSWORD` | App password for ATProto authentication |

### Optional

| Variable | Default | Description |
|---|---|---|
| `LEAF_URL` | `https://leaf-dev.muni.town` | Leaf server URL |
| `LEAF_SERVER_DID` | `did:web:<LEAF_URL hostname>` | Leaf server DID |
| `STREAM_NSID` | `space.roomy.space.personal.dev` | Stream NSID |
| `STREAM_HANDLE_NSID` | `space.roomy.space.handle.dev` | Handle NSID |
| `BRIDGE_DATA_DIR` | `./data` | Directory for SQLite database |
| `BRIDGE_DB_PATH` | `${BRIDGE_DATA_DIR}/bridge.sqlite` | Path to SQLite database |
| `PORT` | `3301` | HTTP port for bridge API (`/info`, `/get-guild-id`, `/get-space-id`, `/bridges`) |
| `LOG_LEVEL` | `info` | Log level |

## Slash commands

All commands require **Administrator** permissions and only work in guilds.

| Command | Description |
|---|---|
| `/connect-roomy-space space-id:<did>` | Connect a Roomy space to this Discord guild (full mode) |
| `/disconnect-roomy-space [space-id:<did>]` | Disconnect a bridged space. Omit space-id if only one bridge exists. |
| `/roomy-status` | Show all connected bridges and their mode |
| `/roomy-bridge-channel add channel:#channel [space-id:<did>]` | Add a channel to the allowlist (switches bridge to subset mode if currently full) |
| `/roomy-bridge-channel remove channel:#channel [space-id:<did>]` | Remove a channel from the allowlist. Existing synced messages are preserved. |
| `/roomy-bridge-channel list [space-id:<did>]` | List channels in the allowlist |

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
  -e S3_BUCKET=... \
  -e S3_ENDPOINT=... \
  -e S3_REGION=... \
  -e S3_ACCESS_KEY_ID=... \
  -e S3_SECRET_ACCESS_KEY=... \
  -v bridge-data:/data \
  roomy-discord-bridge
```

The entrypoint restores the SQLite database from S3 on first start (if no local DB exists) and wraps the Bun process with Litestream for continuous replication.

### Local development

```bash
cp .env.example .env
# Fill in DISCORD_TOKEN, ATPROTO_BRIDGE_DID, ATPROTO_BRIDGE_APP_PASSWORD
bun install
bun run dev       # watch mode
bun run start     # production mode
```

## Migration from legacy bridge

This package does not migrate state from the legacy `discord-bridge-legacy` package. New bridges start with an empty SQLite database. Legacy bridges continue running on the legacy package until decommissioned externally — both can coexist on different bot tokens.
