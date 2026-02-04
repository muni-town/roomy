# Discord Bridge for Roomy

A bidirectional synchronization service that connects Discord servers with Roomy spaces, enabling seamless message, reaction, and profile sync between platforms.

## Overview

The Discord Bridge is a standalone microservice that:
- Syncs messages from Discord channels to Roomy rooms (and vice versa)
- Maintains reaction parity across platforms
- Preserves user profiles with "puppeting" for webhook messages
- Supports both real-time sync and historical backfill
- Uses idempotent event patterns to prevent duplicates and handle restarts

## Architecture

### System Components

```
┌─────────────────┐     ┌─────────────────┐
│   Discord       │     │    Roomy        │
│   (Guild)       │◄──► │    (Space)      │
└────────┬────────┘     └────────┬────────┘
         │                      │
         │    ┌──────────────────┘
         │    │
         ▼    ▼
┌─────────────────────────────────┐
│     Discord Bridge Service      │
│  ┌───────────────────────────┐  │
│  │  Discord Bot (Discordeno) │  │
│  │  - Event listeners        │  │
│  │  - Webhook execution      │  │
│  │  - Backfill engine        │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  Roomy Client (ATProto)    │  │
│  │  - Leaf subscriptions     │  │
│  │  - Event streaming        │  │
│  │  - Profile fetching       │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  LevelDB State Store      │  │
│  │  - Mappings (syncedIds)   │  │
│  │  - Profiles (cached)       │  │
│  │  - Cursors (resume state)  │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  HTTP API                 │  │
│  │  - Health checks           │  │
│  │  - Bridge management       │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Directory Structure

```
packages/discord-bridge/src/
├── index.ts              # Entry point, initializes all subsystems
├── api.ts                # Express REST API for bridge management
├── env.ts                # Environment variable configuration
├── db.ts                 # LevelDB store factories and types
├── tracing.ts            # OpenTelemetry observability
├── otel.ts               # OTel exporter configuration
├── httpProxy.ts          # HTTP proxy for Leaf authentication
│
├── discord/              # Discord-specific code
│   ├── bot.ts            # Bot initialization, event handlers, backfill orchestration
│   ├── types.ts          # TypeScript types, desired properties configuration
│   ├── webhooks.ts       # Webhook creation, execution, retry logic
│   ├── slashCommands.ts  # Discord slash commands (/connect, etc.)
│   └── backfill.ts       # Discord message hashing, reaction backfill
│
├── roomy/                # Roomy-specific code
│   ├── client.ts         # RoomyClient initialization, space subscriptions
│   ├── subscription.ts   # Leaf event handler, state updates, filter logic
│   ├── to.ts             # Discord → Roomy sync (messages, reactions, profiles)
│   ├── from.ts           # Roomy → Discord sync (webhook execution)
│   ├── backfill.ts       # Roomy → Discord backfill
│   └── batcher.ts        # Event batching for efficient Leaf operations
│
└── types.ts              # Shared GuildContext type
```

## Data Flow

### Discord → Roomy Sync

**Real-time flow:**
```
Discord Message Event
        │
        ▼
┌───────────────────┐
│  messageCreate    │  (discord/bot.ts)
│  handler          │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ ensureRoomyMessage│
│ forDiscordMessage │  (roomy/to.ts)
└────────┬──────────┘
         │
         ├──► Check idempotency (syncedIds)
         ├──► Ensure user profile synced
         ├──► Filter system messages
         ├──► Build CreateMessage event
 │        │  with extensions:
 │        │  - discordMessageOrigin (snowflake, guildId)
 │        │  - authorOverride (DID)
 │        │  - timestampOverride
 │        └──► Send via ConnectedSpace
│
┌───────────────────┐
│ subscription       │  (roomy/subscription.ts)
│ handler           │
└────────┬──────────┘
         │
         ├──► Extract discordMessageOrigin extension
         ├──► Register mapping: snowflake ↔ Roomy ULID
         └──► Update cursor (resume position)
```

**Backfill flow:**
```
Discord API (getMessages)
        │
        ▼
┌───────────────────┐
│ backfillMessages   │  (discord/bot.ts)
│ ForChannel        │
└────────┬──────────┘
         │
         ├──► Fetch messages (pagination, 100 at a time)
         ├──► For each message:
         │    ├──► ensureRoomyChannelForDiscordChannel
         │    ├──► ensureRoomyMessageForDiscordMessage
         │    └──► Store latest message cursor
         └──► After messages: backfillDiscordReactions
```

### Roomy → Discord Sync

**Real-time flow:**
```
Leaf Event Stream
        │
        ▼
┌───────────────────┐
│ subscription       │  (roomy/subscription.ts)
│ handler           │
└────────┬──────────┘
         │
         ├──► Filter Discord-origin events (prevent loop-back)
         │    - Check for discordMessageOrigin extension
         │    - Check for discordOrigin extension
         │    - Check for discordUserOrigin extension
         │
         ▼
┌───────────────────┐
│ syncCreateMessage  │  (roomy/from.ts)
│ ToDiscord         │
└────────┬──────────┘
         │
         ├──► Get Discord channel ID (from syncedIds)
         ├──► Check idempotency (nonce check)
         ├──► Get webhook for channel
         ├──► Extract author profile:
         │    - authorOverride.did for Discord users
         │    - decodedEvent.user for Roomy users
         │    - Fetch from ATProto if not cached
         │
         ▼
┌───────────────────┐
│ executeWebhook    │  (discord/webhooks.ts)
│ withRetry         │
└────────┬──────────┘
         │
         ├──► Send message via Discord webhook
         ├──► Register mapping: snowflake ↔ Roomy ULID
         └──► Handle webhook deleted (404) - recreate and retry
```

**Backfill flow:**
```
Leaf Event Stream (fetchRoomyOriginEvents)
        │
        ▼
┌───────────────────┐
│ backfillRoomyTo   │  (roomy/backfill.ts)
│ Discord           │
└────────┬──────────┘
         │
         ├──► Fetch Roomy events (batched, 2500 at a time)
         ├──► Filter Discord-origin events
         ├──► Compute content hash (deduplication)
         ├──► Check for duplicates on Discord (hash lookup)
         ├──► Send via webhook
         └──► Register mappings
```

### Reaction Sync

**Discord → Roomy:**
```
Discord reactionAdd Event
        │
        ▼
┌───────────────────┐
│ reactionAdd       │  (discord/bot.ts)
│ handler           │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ syncDiscord       │  (roomy/to.ts)
│ ReactionToRoomy   │
└────────┬──────────┘
         │
         ├──► Check idempotency (syncedReactions store)
         ├──► Get Roomy message ID (from syncedIds)
         ├──► Build addBridgedReaction event
         │    - reactingUser: did:discord:{userId}
         │    - discordReactionOrigin extension (prevent loop-back)
         └──► Send via ConnectedSpace
```

**Roomy → Discord:**
```
Leaf Event Stream (addReaction/addBridgedReaction)
        │
        ▼
┌───────────────────┐
│ subscription       │  (roomy/subscription.ts)
│ handler           │
└────────┬──────────┘
         │
         ├──► Filter: Allow reactions bidirectionally
         │    - Block if discordReactionOrigin present (loop prevention)
         │
         ▼
┌───────────────────┐
│ syncAddReaction    │  (roomy/from.ts)
│ ToDiscord         │
└────────┬──────────┘
         │
         ├──► Get Discord message ID (from syncedIds)
         ├──► Parse emoji (unicode or custom)
         └──► Call bot.helpers.addReaction()
```

### Profile Sync

**Discord → Roomy:**
```
Discord User (any message/reaction)
        │
        ▼
┌───────────────────┐
│ ensureRoomyProfile│  (roomy/to.ts)
│ forDiscordUser    │
└────────┬──────────┘
         │
         ├──► Compute profile hash (username + globalName + avatar)
         ├──► Check if changed (syncedProfiles store)
         ├──► Build updateProfile event
         │    - did: did:discord:{userId}
         │    - name: globalName || username
         │    - avatar: avatar URL (Discord CDN)
         │    - discordUserOrigin extension
         └──► Send via ConnectedSpace
```

**Roomy → Discord (Puppeting):**
```
Roomy Message Event
        │
        ▼
┌───────────────────┐
│ syncCreateMessage  │  (roomy/from.ts)
│ ToDiscord         │
└────────┬──────────┘
         │
         ├──► Extract author DID:
         │    - authorOverride.did for bridged messages
         │    - decodedEvent.user for pure Roomy messages
         │
         ▼
┌───────────────────┐
│ Profile Lookup    │
│ (with ATProto     │
│  fallback)        │
└────────┬──────────┘
         │
         ├──► Check cache (roomyUserProfilesForBridge)
         ├──► If not cached: fetch from ATProto (getProfile)
         ├──► Cache for future use
         └──► Use in webhook payload (username, avatarUrl)
```

## Idempotency and Sync Patterns

The bridge uses extension-based idempotency to prevent duplicate events and sync loops:

### Discord-Origin Extensions

All events originating from Discord include an extension to mark their origin:

| Extension | Purpose | Events |
|-----------|---------|--------|
| `discordMessageOrigin.v0` | Message sync tracking | createMessage, editMessage |
| `discordOrigin.v0` | Room/thread creation | createRoom |
| `discordUserOrigin.v0` | Profile sync tracking | updateProfile |
| `discordSidebarOrigin.v0` | Sidebar change tracking | updateSidebar |
| `discordRoomLinkOrigin.v0` | Thread link tracking | createRoomLink |
| `discordReactionOrigin.v0` | Reaction sync tracking | addBridgedReaction, removeBridgedReaction |

### Sync Loop Prevention

**Problem:** Without origin tracking, we get infinite loops:
```
Discord → Roomy → Discord → Roomy → ...
```

**Solution:** Filter events in subscription handler:
```typescript
// Don't sync events back that originated from Discord
if (!messageOrigin && !roomOrigin && !userOrigin && !reactionOrigin) {
  // Sync to Discord
}

// Exception: Reactions sync bidirectionally (Roomy ↔ Discord)
// But filter out reactions with discordReactionOrigin (loop prevention)
if (isReactionEvent && !reactionOrigin) {
  // Sync reactions
}
```

### Message Idempotency

**Roomy → Discord:**
1. **Nonce-based:** Truncate Roomy ULID to 25 chars, use as Discord webhook nonce
2. **Hash-based:** SHA-256 hash of content + attachments
3. **Double registration:**
   - `nonce → Discord snowflake` (prevents duplicate sends)
   - `snowflake → Roomy ULID` (enables reaction sync)

**Discord → Roomy:**
1. **Snowflake mapping:** `discordId: snowflake → roomyId: ULID`
2. **Edit tracking:** `editedTimestamp + contentHash` (timestamp-first, hash fallback)
3. **Reaction tracking:** `${messageId}:${userId}:${emojiKey} → reactionEventId`

### Database Schema

The bridge uses LevelDB with sublevel databases for organization:

```typescript
// Bridge registration
registeredBridges: {
  guildId: string,
  spaceId: string
}

// Per-bridge stores (scoped by guildId and spaceId)
syncedIds: {
  discordId: string,  // Can be "room:123" for channels, "456" for messages
  roomyId: string     // Roomy ULID
}

syncedReactions: {
  key: string,        // "${messageId}:${userId}:${emojiKey}"
  value: string       // Roomy reaction event ID
}

syncedProfiles: {
  key: string,        // Discord user snowflake
  value: string       // Profile hash (change detection)
}

roomyUserProfiles: {
  key: string,        // Roomy user DID
  value: {            // Cached profile data
    name: string,
    avatar: string | null,
    handle?: string
  }
}

syncedSidebarHash: {
  key: "sidebar",
  value: string       // Hash of sidebar structure
}

syncedRoomLinks: {
  key: string,        // "${parentRoomyId}:${childRoomyId}"
  value: string       // Roomy link event ID
}

syncedEdits: {
  key: string,        // Discord message snowflake
  value: {            // Edit tracking data
    editedTimestamp: number,
    contentHash: string
  }
}

discordMessageHashes: {
  key: string,        // "${nonce}:${hash}" or ":${hash}"
  value: Record<      // Map of hashes → Discord message IDs
    string,
    string
  >
}

discordLatestMessageInChannel: {
  key: string,        // Discord channel ID
  value: string       // Latest message snowflake (for backfill resume)
}

discordWebhookTokens: {
  key: string,        // Discord channel ID
  value: string       // "webhookId:webhookToken"
}

leafCursors: {
  key: string,        // Space DID
  value: number       // Last processed event index
}
```

## Configuration

### Environment Variables

Create `.env` file in `packages/discord-bridge/`:

```bash
# Discord Bot
DISCORD_TOKEN=your_discord_bot_token_here

# ATProto / Roomy Authentication
ATPROTO_BRIDGE_DID=did:plc:your_bridge_did
ATPROTO_BRIDGE_APP_PASSWORD=your_app_password_here

# Leaf Server
LEAF_URL=https://your-leaf-server.com
LEAF_SERVER_DID=did:web:your-leaf-server.com

# Stream Configuration
STREAM_NSID=com.example.stream
STREAM_HANDLE_NSID=streams.example.space

# HTTP API
PORT=3301
NODE_ENV=development

# Data Storage
DATA_DIR=./data
```

### Getting Started

1. **Create Discord Application:**
   - Go to https://discord.com/developers/applications
   - Create a bot with these permissions:
     - `Read Messages/View Channels`
     - `Send Messages`
     - `Manage Messages`
     - `Add Reactions`
     - `Read Message History`
     - `Use Webhooks`

2. **Create ATProto Bridge Account:**
   - Use an existing Bluesky account or create a new one
   - Generate an app password at https://bsky.app/settings

3. **Run the Service:**
   ```bash
   cd packages/discord-bridge
   npm install
   npm run dev
   ```

4. **Connect a Space:**
   - Use the Roomy admin UI to create a bridge
   - Or manually register in LevelDB (see API endpoints)

## Development

### Build

```bash
pnpm build-discord-bridge
```

### Watch Mode

```bash
pnpm dev:discord-bridge
```

### Testing

The bridge includes comprehensive logging and tracing via OpenTelemetry. Key log prefixes to watch:

- `[Profile Puppeting]` - Profile fetching and webhook puppeting
- `[Profile Capture]` - Profile caching from updateProfile events
- `[Backfill Webhook]` - Roomy → Discord backfill operations
- `[Webhook Registration]` - Message mapping registration

### Troubleshooting

**Messages not syncing:**
- Check if channel is synced (should have mapping in syncedIds)
- Verify bot has permissions for that channel
- Check logs for "skipped" messages with reasons

**Reactions creating duplicates:**
- Verify discordReactionOrigin extension is being added
- Check subscription filter logic

**Profile puppeting not working:**
- Check if authorOverride.did is present on Roomy events
- Verify ATProto profile fetching is working
- Check roomyUserProfiles cache

**Reactions on webhook messages not syncing:**
- Verify webhook message registration (snowflake → ULID mapping)
- Check logs for "not synced to Roomy" warnings

### Key Patterns

**Hash-based change detection:**
```typescript
// Compute hash for profile/sidebar/edit change detection
function fingerprint(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}
```

**Bidirectional mapping:**
```typescript
// Creates both directions automatically
await syncedIds.register({
  discordId: snowflake,
  roomyId: ulid
});
// Now works both ways:
await syncedIds.get_discordId(ulid)    // → snowflake
await syncedIds.get_roomyId(snowflake) // → ulid
```

**Extension extraction pattern:**
```typescript
function extractExtension<T>(
  event: Event,
  extensionKey: string,
  eventType?: string
): T | undefined {
  if (eventType && event.$type !== eventType) return undefined;
  const extensions = event.extensions || {};
  return extensions[extensionKey] as T | undefined;
}
```

## Related Documentation

- [SDK Event Schemas](../../sdk/src/schema/events/) - Event type definitions
- [Plan Documents](../../../docs/plans/) - Implementation details and decisions
- [Discordeno Documentation](https://discordeno.js.org/) - Discord bot framework
