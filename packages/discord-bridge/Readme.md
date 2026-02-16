# Discord Bridge for Roomy

A bidirectional synchronization service that connects Discord servers with Roomy spaces, enabling seamless message, reaction, and profile sync between platforms.

## Overview

The Discord Bridge is a standalone microservice that:
- Syncs messages from Discord channels to Roomy rooms (and vice versa)
- Maintains reaction parity across platforms
- Double puppeting (profiles sync across platforms)
- Supports both real-time sync and historical backfill
- Exactly-once delivery

## Limitations

Some features are currently not feasible or otherwise out of scope:
- Due to Discord API limitations, only one reaction per emoji can be sent from Roomy to Discord, with no profile puppeting
- Categories are not currently synced
- During bridge downtime, Discord message deletions may be missed (auto-cleanup not yet implemented)
- Channels originally created on Roomy can be synced, however they must retain a tag in the topic with the Roomy room ID

## Architecture

The Discord Bridge uses a **singleton orchestrator + per-guild bridge** architecture with domain-driven service separation:

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
│     BridgeOrchestrator          │
│  (Singleton - manages all       │
│   guilds, Discord bot lifecycle)│
│  ┌───────────────────────────┐  │
│  │  Bridge (per guild-space) │  │
│  │  ┌─────────────────────┐  │  │
│  │  │ EventDispatcher     │  │  │
│  │  │ - toRoomy channel   │  │  │
│  │  │ - toDiscord channel │  │  │
│  │  └─────────────────────┘  │  │
│  │  ┌─────────────────────┐  │  │
│  │  │ Domain Services     │  │  │
│  │  │ - MessageSync       │  │  │
│  │  │ - ReactionSync      │  │  │
│  │  │ - ProfileSync       │  │  │
│  │  │ - StructureSync     │  │  │
│  │  └─────────────────────┘  │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  Discord Bot (Discordeno) │  │
│  │  - Event listeners        │  │
│  │  - Webhook execution      │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  Roomy Client (ATProto)   │  │
│  │  - Leaf subscriptions     │  │
│  │  - Event streaming        │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  BridgeRepository         │  │
│  │  - LevelDB stores         │  │
│  │  - Mappings, cursors      │  │
│  │  - Profile cache          │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │  HTTP API (itty-router)   │  │
│  │  - Bridge info            │  │
│  │  - Guild/space lookup     │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Directory Structure

```
packages/discord-bridge/src/
├── index.ts              # Entry point, creates BridgeOrchestrator + HTTP API
├── BridgeOrchestrator.ts # Singleton: bot lifecycle, event routing to bridges
├── Bridge.ts             # Per-guild coordinator: backfill phases, event handling
├── dispatcher.ts         # EventDispatcher: async channels for bidirectional sync
├── constants.ts          # Shared constants (message types, key prefixes)
├── api.ts                # itty-router REST API
├── env.ts                # Environment variable configuration
├── tracing.ts            # OpenTelemetry observability
├── otel.ts               # OTel exporter configuration
├── httpProxy.ts          # HTTP proxy for Leaf authentication
│
├── services/             # Domain sync services
│   ├── MessageSyncService.ts  # Message sync logic (bidirectional)
│   ├── ReactionSyncService.ts # Reaction sync logic (bidirectional)
│   ├── ProfileSyncService.ts  # Profile sync logic (Discord → Roomy)
│   ├── StructureSyncService.ts # Channel/room/thread/sidebar sync
│   └── index.ts
│
├── repositories/         # Data access layer
│   ├── BridgeRepository.ts        # Repository interface
│   ├── LevelDBBridgeRepository.ts # LevelDB implementation
│   ├── MockBridgeRepository.ts    # Test double
│   └── index.ts
│
├── discord/              # Discord-specific code
│   ├── types.ts          # TypeScript types, DiscordEvent union, desired properties
│   ├── webhooks.ts       # Webhook creation, execution, retry logic
│   ├── slashCommands.ts  # Discord slash commands (/connect-roomy-space, etc.)
│   ├── backfill.ts       # Discord message hashing, reaction backfill
│   ├── websocket-polyfill.ts # WebSocket polyfill for Discordeno
│   └── operations/       # Discord API operations
│       └── channel.ts    # Channel-specific operations
│
├── roomy/                # Roomy-specific code
│   ├── client.ts         # RoomyClient initialization (ATProto auth)
│   └── batcher.ts        # Event batching for efficient Leaf operations
│
└── utils/                # Shared utilities
    ├── event-extensions.ts # Extension extraction for idempotency/loop prevention
    ├── hash.ts            # SHA-256 fingerprinting
    ├── emoji.ts           # Emoji parsing (unicode/custom)
    ├── message.ts         # Message content utilities
    ├── room.ts            # Room key helpers
    └── discord-topic.ts   # Discord topic sync
```

### Architecture Principles

**BridgeOrchestrator (singleton)**
- Manages the Discord bot lifecycle and event routing
- Routes Discord events to the correct Bridge by guild ID
- Handles slash command interactions
- Creates/destroys Bridge instances on connect/disconnect

**Bridge (per guild-space pair)**
- Coordinates sync for a single Discord guild ↔ Roomy space
- Runs a four-phase backfill process on connection (see below)
- Uses an EventDispatcher for decoupled async event routing
- Delegates to four domain services

**Service Layer (services/)**
- Domain-driven separation: messages, reactions, profiles, structure
- Each service handles both directions (Roomy events + Discord events)
- Services receive events via `handleRoomyEvent()` and direct calls from Bridge
- Services push outbound events to the dispatcher's async channels

**Repository Layer (repositories/)**
- Single source of truth for all persistent state
- LevelDB-backed with typed interfaces
- Sublevel databases for different data domains
- Mock implementation for testing

**EventDispatcher**
- Two async channels: `toRoomy` (Discord → Roomy) and `toDiscord` (Roomy → Discord)
- Batches events during backfill, sends immediately when listening
- Enables decoupled communication between phases

## Data Flow

### Four-Phase Backfill Process

When a Bridge connects to a guild-space pair, it runs four phases sequentially:

```
Phase 1: backfillRoomyAndSubscribe
  - Subscribe to Roomy Leaf event stream (resuming from cursor)
  - Process all existing Roomy events through services
  - Each service registers Discord-origin mappings (snowflake ↔ ULID)
  - Roomy-origin events are queued to dispatcher.toDiscord
  - Completes when ConnectedSpace.doneBackfilling resolves

Phase 2: backfillDiscordAndSyncToRoomy
  - Backfill Discord structure (channels, threads) via StructureSyncService
  - Backfill messages for all text channels via MessageSyncService
  - Backfill reactions via ReactionSyncService
  - Events batched to dispatcher.toRoomy, flushed at batch size or phase end

Phase 3: syncRoomyToDiscord
  - Consume queued Roomy-origin events from dispatcher.toDiscord
  - Distribute to services: ReactionSync, StructureSync, MessageSync
  - Each service syncs Roomy-origin data to Discord via webhooks
  - Transitions to "listening" when last batch event is processed

Phase 4: listening (steady-state)
  - New Discord events → Bridge.handleDiscordEvent() → service → dispatcher.toRoomy → Roomy
  - New Roomy events → Bridge.handleRoomyEvents() → services → dispatcher.toDiscord → Discord
  - Events sent immediately (no batching)
```

### Discord → Roomy Sync

**Real-time flow (Phase 4):**
```
Discord Event (message, reaction, channel, etc.)
        │
        ▼
┌───────────────────┐
│ BridgeOrchestrator│  (BridgeOrchestrator.ts)
│ .handleDiscordEvent│  Routes by guildId
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Bridge            │  (Bridge.ts)
│ .handleDiscordEvent│  Type-safe switch on event type
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ MessageSyncService│  (services/MessageSyncService.ts)
│ .syncDiscordToRoomy│
└────────┬──────────┘
         │
         ├──► Check idempotency (syncedIds)
         ├──► Ensure user profile synced (via ProfileSyncService)
         ├──► Filter system messages (constants.ts)
         ├──► Build CreateMessage event with extensions:
         │    - discordMessageOrigin (snowflake, guildId)
         │    - authorOverride (DID)
         │    - timestampOverride
         └──► Push to dispatcher.toRoomy → ConnectedSpace
```

**Backfill flow (Phase 2):**
```
Discord API (getMessages)
        │
        ▼
┌───────────────────┐
│ MessageSyncService│  (services/MessageSyncService.ts)
│ .backfillToRoomy  │
└────────┬──────────┘
         │
         ├──► Fetch messages per channel (pagination, 100 at a time)
         ├──► For each message:
         │    ├──► Check idempotency
         │    ├──► Build event with extensions
         │    └──► Push to dispatcher.toRoomy (batched)
         └──► Batch flushed to Roomy at batch size or phase end
```

### Roomy → Discord Sync

**Real-time flow (Phase 4):**
```
Leaf Event Stream
        │
        ▼
┌───────────────────┐
│ Bridge            │  (Bridge.ts)
│ .handleRoomyEvents│  Routes to services in priority order
└────────┬──────────┘
         │
         ├──► ProfileSync.handleRoomyEvent  (register Discord-origin profiles)
         ├──► StructureSync.handleRoomyEvent (register rooms, queue Roomy-origin)
         ├──► MessageSync.handleRoomyEvent   (register messages, queue Roomy-origin)
         └──► ReactionSync.handleRoomyEvent  (register reactions, queue Roomy-origin)
                    │
                    ▼  (Roomy-origin events pushed to dispatcher.toDiscord)
┌───────────────────┐
│ Service           │
│ .syncToDiscord    │  Distributes queued events
└────────┬──────────┘
         │
         ├──► Get Discord channel ID (from syncedIds)
         ├──► Get webhook for channel
         ├──► Extract author profile (via ProfileSyncService)
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

### Reaction Sync

**Discord → Roomy:**
```
Discord reactionAdd Event
        │
        ▼
┌───────────────────┐
│ Bridge            │  (Bridge.ts)
│ .handleDiscordEvent│  case "REACTION_ADD"
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ ReactionSync      │  (services/ReactionSyncService.ts)
│ .syncAddToRoomy   │
└────────┬──────────┘
         │
         ├──► Check idempotency (syncedReactions store)
         ├──► Get Roomy message ID (from syncedIds)
         ├──► Build addBridgedReaction event
         │    - reactingUser: did:discord:{userId}
         │    - discordReactionOrigin extension (prevent loop-back)
         └──► Push to dispatcher.toRoomy
```

**Roomy → Discord:**
```
Leaf Event Stream (addReaction/addBridgedReaction)
        │
        ▼
┌───────────────────┐
│ ReactionSync      │  (services/ReactionSyncService.ts)
│ .handleRoomyEvent │  (registers Discord-origin, queues Roomy-origin)
└────────┬──────────┘
         │ (queued to dispatcher.toDiscord)
         ▼
┌───────────────────┐
│ ReactionSync      │  (services/ReactionSyncService.ts)
│ .syncToDiscord    │
└────────┬──────────┘
         │
         ├──► Filter: Block if discordReactionOrigin present (loop prevention)
         ├──► Get Discord message ID (from syncedIds)
         ├──► Parse emoji (unicode or custom via utils/emoji.ts)
         └──► Call bot.helpers.addReaction()
```

### Profile Sync

**Discord → Roomy:**
```
Discord User (any message/reaction)
        │
        ▼
┌───────────────────┐
│ ProfileSync       │  (services/ProfileSyncService.ts)
│ .syncDiscord      │
│ ToRoomy           │
└────────┬──────────┘
         │
         ├──► Compute profile hash (username + globalName + avatar)
         ├──► Check if changed (syncedProfiles store)
         ├──► Build updateProfile event
         │    - did: did:discord:{userId}
         │    - name: globalName || username
         │    - avatar: avatar URL (Discord CDN)
         │    - discordUserOrigin extension
         └──► Push to dispatcher.toRoomy
```

**Roomy → Discord (Puppeting):**
```
Roomy Message Event
        │
        ▼
┌───────────────────┐
│ MessageSync       │  (services/MessageSyncService.ts)
│ .syncToDiscord    │
└────────┬──────────┘
         │
         ├──► Extract author DID:
         │    - authorOverride.did for bridged messages
         │    - decodedEvent.user for pure Roomy messages
         │
         ▼
┌───────────────────┐
│ ProfileSync       │  (services/ProfileSyncService.ts)
│ .getRoomyProfile  │
└────────┬──────────┘
         │
         ├──► Check cache (roomyUserProfiles)
         ├──► If not cached: fetch from ATProto (getProfile)
         ├──► Cache for future use
         └──► Return profile for webhook payload (username, avatarUrl)
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

**Solution:** Each service's `handleRoomyEvent()` uses `utils/event-extensions.ts` to extract origin markers:
```typescript
import { extractDiscordMessageOrigin } from "../utils/event-extensions.js";

// In handleRoomyEvent():
const origin = extractDiscordMessageOrigin(decodedEvent);
if (origin) {
  // Discord-origin: register mapping (snowflake ↔ ULID), don't sync back
  await repo.syncedIds.register({ discordId: origin.snowflake, roomyId: event.id });
  return true; // handled
}
// Roomy-origin: queue to dispatcher.toDiscord for Phase 3
dispatcher.toDiscord.push({ decoded: decodedEvent, batchId, isLastEvent });
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

- `[Bridge]` - Phase transitions and backfill progress
- `[Dispatcher]` - Event batching and flushing
- `[Profile Puppeting]` - Profile fetching and webhook puppeting
- `[Webhook Registration]` - Message mapping registration

**Testing with Mock Repositories:**

The modular architecture supports testing with `MockBridgeRepository`:

```typescript
import { MockBridgeRepository } from "./repositories/MockBridgeRepository.js";
import { MessageSyncService } from "./services/MessageSyncService.js";
import { createDispatcher } from "./dispatcher.js";

// Create mock repository and dispatcher
const mockRepo = new MockBridgeRepository();
const dispatcher = createDispatcher();

// Create service with mock dependencies
const service = new MessageSyncService(
  mockRepo,
  streamDid,
  dispatcher,
  guildId,
  profileSync,
  mockBot,
);

// Test sync operations without touching LevelDB
await service.syncDiscordToRoomy(message);

// Assert on repository state
const mapping = await mockRepo.syncedIds.get_discordId(snowflake);
expect(mapping).toBeDefined();
```

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
// Compute hash for profile/sidebar/edit change detection (utils/hash.ts)
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

**Extension extraction (utils/event-extensions.ts):**
```typescript
import {
  extractDiscordMessageOrigin,
  extractDiscordOrigin,
  extractDiscordUserOrigin,
  extractDiscordReactionOrigin,
} from "./utils/event-extensions.js";

// Type-safe extraction with typed return values
const msgOrigin = extractDiscordMessageOrigin(decodedEvent);
// → { snowflake, channelId, guildId, editedTimestamp?, contentHash? } | undefined

const roomOrigin = extractDiscordOrigin(decodedEvent);
// → { snowflake, guildId } | undefined
```

**Event dispatcher pattern:**
```typescript
// Services push events to async channels
dispatcher.toRoomy.push(event);       // Discord → Roomy
dispatcher.toDiscord.push({ decoded, batchId, isLastEvent }); // Roomy → Discord

// Bridge consumes from channels
for await (const event of dispatcher.toRoomy) {
  await connectedSpace.sendEvent(event);
}
```

**Type-safe Discord event routing:**
```typescript
// DiscordEvent is a discriminated union (discord/types.ts)
type DiscordEvent =
  | { event: "MESSAGE_CREATE"; payload: { guildId: bigint; ... } }
  | { event: "REACTION_ADD"; payload: { guildId: bigint; ... } }
  | ...;

// Bridge switches on event type with exhaustive checking
async handleDiscordEvent(discordEvent: DiscordEvent) {
  switch (discordEvent.event) {
    case "MESSAGE_CREATE":
      await this.messageSync.syncDiscordToRoomy(discordEvent.payload);
      break;
    // ...
  }
}
```

## Related Documentation

- [SDK Event Schemas](../../sdk/src/schema/events/) - Event type definitions
- [Plan Documents](../../../docs/plans/) - Implementation details and decisions
- [Discordeno Documentation](https://discordeno.js.org/) - Discord bot framework
