# Discord Bridge — Abstraction & Isolation Plan

## Problem

Every service in the bridge depends on all three of:

- **DiscordBot** (Discordeno) — the live Discord connection
- **BridgeRepository** (SQLite) — persistence
- **SpaceManager** (Roomy) — the destination

This makes isolated testing impossible without mocking all three. Backfill debugging requires a live guild. Adding a new data source (JSON exports, test fixtures) means changing every service.

## Goal

Decouple the bridge into three layers with well-defined interfaces, so each can be tested, swapped, and developed independently.

```
┌──────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│  Discord Source  │────▶│   Service Core       │────▶│  Roomy Gateway  │
│  (adapter)       │     │   (pure logic)       │     │  (adapter)      │
├──────────────────┤     ├─────────────────────┤     ├─────────────────┤
│ LiveDiscord      │     │ backfillChannel()    │     │ SpaceManager    │
│ FileDiscord      │     │ ingestMessage()      │     │ MockSpaceMgr    │
│ FakeDiscord      │     │ ensureRoom()          │     │                 │
└──────────────────┘     │ syncProfile()        │     └─────────────────┘
                          │ syncReaction()       │
                          └─────────────────────┘
                                   │
                          ┌────────▼────────┐
                          │  Repository     │
                          │  (persistence)  │
                          └─────────────────┘
```

## Phase 1 — Plain Data Types

**Problem:** Services import `MessageProperties`, `ChannelProperties`, `DiscordBot` from `@discordeno/bot`. These types carry 50+ fields the services don't use and tie every function to Discordeno's type system.

**Solution:** Define focused data types that represent just what the services need.

```typescript
// src/discord/data.ts  (new file)

export interface DiscordMessageData {
  id: string;
  channelId: string;
  guildId?: string;
  type: number;
  content: string;
  timestamp: string;
  editedTimestamp: string | null;
  author: DiscordUserData;
  attachments: DiscordAttachmentData[];
  embeds: DiscordEmbedData[];
  reactions: DiscordReactionData[];
  mentions: DiscordUserData[];
  mentionChannelIds?: string[];
  stickerItems?: DiscordStickerData[];
  messageReference?: {
    messageId: string | null;
    channelId: string;
    guildId: string;
  };
}

export interface DiscordUserData {
  id: string;
  name: string;
  discriminator: string;
  globalName?: string | null;
  avatar?: string | null;
  isBot?: boolean;
}

export interface DiscordChannelData {
  id: string;
  type: number;
  name?: string;
  parentId?: string;
  guildId?: string;
  topic?: string | null;
  permissionOverwrites?: Array<{ id: string; deny?: string[] }>;
}

export interface DiscordGuildData {
  id: string;
  channels?: DiscordChannelData[];
}

export interface DiscordAttachmentData {
  id: string;
  url: string;
  filename: string;
  contentType?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface DiscordReactionData {
  emoji: { id: string; name: string; animated?: boolean };
  count: number;
  userIds: string[];
}

export interface DiscordStickerData {
  id: string;
  formatType: number;
}

export interface DiscordEmbedData {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  // only fields the services actually use
}
```

**Migration:** Each service gets a `normalize*` helper that converts from Discordeno types to these plain types. The service internals then operate on the plain types only. This is a mechanical change — no logic is altered.

**Testability win:** Test fixtures can be plain objects, not Discordeno mocks.

---

## Phase 2 — DiscordDataSource Interface

**Problem:** `backfill.ts` calls `bot.helpers.getMessages()`, `bot.cache.guilds.memory.get()`, `bot.helpers.getPublicArchivedThreads()`. `room-sync.ts` calls `bot.cache.guilds.memory.get()`. Every service that touches Discord data reaches into the Discord bot object directly.

**Solution:** Define a `DiscordDataSource` interface that abstracts all Discord reads.

```typescript
// src/discord/data-source.ts  (new file)

export interface PaginationOpts {
  after?: string;
  before?: string;
  limit?: number;
}

export interface ThreadPage {
  threads: DiscordChannelData[];
  hasMore: boolean;
}

export interface DiscordDataSource {
  /** Fetch messages from a channel, newest-first (Discord API order). */
  getMessages(
    channelId: string,
    opts: PaginationOpts,
  ): Promise<DiscordMessageData[]>;

  /** Get a single channel by ID. */
  getChannel(channelId: string): Promise<DiscordChannelData | undefined>;

  /** Get all top-level channels for a guild. */
  getChannels(guildId: string): Promise<DiscordChannelData[]>;

  /** Get a guild by ID. */
  getGuild(guildId: string): Promise<DiscordGuildData | undefined>;

  /** Fetch public archived threads for a channel. */
  getPublicArchivedThreads(
    channelId: string,
    opts: PaginationOpts,
  ): Promise<ThreadPage>;

  /** Resolve a channel's name (may require REST fallback). */
  resolveChannelName(channelId: string): Promise<string | undefined>;

  /** Resolve a channel's type (may require REST fallback). */
  resolveChannelType(channelId: string): Promise<number | undefined>;
}
```

### Adapter: LiveDiscordDataSource

Wraps `DiscordBot` (Discordeno). Converts Discordeno types → `DiscordMessageData` etc. via the normalizers from Phase 1.

```typescript
// src/discord/live-data-source.ts  (new file)

export class LiveDiscordDataSource implements DiscordDataSource {
  constructor(private bot: DiscordBot) {}

  async getMessages(
    channelId: string,
    opts: PaginationOpts,
  ): Promise<DiscordMessageData[]> {
    const raw = await this.bot.helpers.getMessages(BigInt(channelId), {
      after: opts.after ? BigInt(opts.after) : undefined,
      before: opts.before ? BigInt(opts.before) : undefined,
      limit: opts.limit ?? 100,
    });
    return raw.map(normalizeMessage);
  }

  async getChannels(guildId: string): Promise<DiscordChannelData[]> {
    const guild = this.bot.cache.guilds.memory.get(BigInt(guildId));
    if (!guild?.channels) return [];
    return [...guild.channels.values()].map(normalizeChannel);
  }

  // ... etc
}
```

### Adapter: FileDiscordDataSource

Reads from Discord JSON export files (or our fake data generator output). Indexes all files on load, serves data from the index.

```typescript
// src/discord/file-data-source.ts  (new file)

export class FileDiscordDataSource implements DiscordDataSource {
  private channels = new Map<string, DiscordChannelData>();
  private messages = new Map<string, DiscordMessageData[]>();
  private guild?: DiscordGuildData;

  constructor(exportDir: string) {
    // Load all JSON files, build index
  }

  async getMessages(
    channelId: string,
    opts: PaginationOpts,
  ): Promise<DiscordMessageData[]> {
    const msgs = this.messages.get(channelId) ?? [];
    // Filter by cursor, paginate, return newest-first
    return paginate(msgs, opts);
  }

  // ... etc
}
```

### Adapter: FakeDiscordDataSource

Wraps our `generate-fake-data.ts` output. Same as `FileDiscordDataSource` but can also generate data on-the-fly for tests.

```typescript
// src/discord/fake-data-source.ts  (new file)

export class FakeDiscordDataSource extends FileDiscordDataSource {
  constructor(seed?: number) {
    const dir = generateFakeExports(seed);
    super(dir);
  }
}
```

**Testability win:** Backfill, room-sync, and any service that reads Discord data can be tested against files or fake data without a live bot.

---

## Phase 3 — RoomyGateway Interface

**Problem:** Services call `spaceManager.getOrConnect(spaceDid)` then `connected.sendEvent(event)`. The `SpaceManager` is already behind a class boundary, but it's a concrete class with real network I/O. The existing `MockSpaceManager` works but is a vi.fn()-based hack.

**Solution:** Define a `RoomyGateway` interface that the mock can implement cleanly.

```typescript
// src/roomy/gateway.ts  (new file)

export interface RoomyGateway {
  sendEvent(spaceDid: string, event: Event): Promise<void>;
  sendEvents(spaceDid: string, events: Event[]): Promise<void>;
  disconnectAll(): Promise<void>;
}
```

### Adapter: LiveRoomyGateway

Wraps `SpaceManager`.

```typescript
// src/roomy/live-gateway.ts  (new file)

export class LiveRoomyGateway implements RoomyGateway {
  constructor(private spaceManager: SpaceManager) {}

  async sendEvent(spaceDid: string, event: Event): Promise<void> {
    const connected = await this.spaceManager.getOrConnect(spaceDid);
    await connected.sendEvent(event);
  }

  async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
    const connected = await this.spaceManager.getOrConnect(spaceDid);
    await connected.sendEvents(events);
  }
}
```

### Adapter: MockRoomyGateway

Records all events for assertion. No vi.fn() needed — pure in-memory.

```typescript
// src/roomy/mock-gateway.ts  (new file)

export class MockRoomyGateway implements RoomyGateway {
  events = new Map<string, Event[]>();

  async sendEvent(spaceDid: string, event: Event): Promise<void> {
    const list = this.events.get(spaceDid) ?? [];
    list.push(event);
    this.events.set(spaceDid, list);
  }

  async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
    const list = this.events.get(spaceDid) ?? [];
    list.push(...events);
    this.events.set(spaceDid, list);
  }

  eventsFor(spaceDid: string): Event[] {
    return this.events.get(spaceDid) ?? [];
  }

  reset(): void {
    this.events.clear();
  }
}
```

**Testability win:** Services can be tested with a `MockRoomyGateway` that captures all events in memory — no network, no vi.fn().

---

## Phase 4 — Refactor Services

Each service becomes a function that takes its dependencies as parameters.

### Before (backfill.ts)

```typescript
export async function runBackfill(
  bot: DiscordBot,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  // uses bot.cache, bot.helpers, repo, spaceManager directly
}
```

### After

```typescript
export async function runBackfill(
  discord: DiscordDataSource,
  repo: BridgeRepository,
  roomy: RoomyGateway,
): Promise<void> {
  // uses discord.getMessages(), repo.*, roomy.sendEvent()
}
```

### Service migration table

| Service                  | Current deps                            | New deps                                     | Notes                                                         |
| ------------------------ | --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `backfill.ts`            | `DiscordBot`, `Repo`, `SpaceMgr`        | `DiscordDataSource`, `Repo`, `RoomyGateway`  | Largest change — pagination loop uses `discord.getMessages()` |
| `message-ingestion.ts`   | `MessageProperties`, `Repo`, `SpaceMgr` | `DiscordMessageData`, `Repo`, `RoomyGateway` | Already mostly decoupled; swap type + gateway                 |
| `room-sync.ts`           | `DiscordBot`, `Repo`, `SpaceMgr`        | `DiscordDataSource`, `Repo`, `RoomyGateway`  | Channel discovery moves to data source                        |
| `profile-sync.ts`        | `Repo`, `SpaceMgr`                      | `Repo`, `RoomyGateway`                       | Already doesn't use DiscordBot directly                       |
| `reaction-sync.ts`       | `Repo`, `SpaceMgr`                      | `Repo`, `RoomyGateway`                       | Same — no DiscordBot dependency                               |
| `message-edit-delete.ts` | `Repo`, `SpaceMgr`                      | `Repo`, `RoomyGateway`                       | Same                                                          |
| `mention-resolver.ts`    | `logger`                                | `logger`                                     | Already isolated ✅                                           |

---

## Phase 5 — Wire It Together

The entry point (`index.ts`) creates the adapters and passes them to services:

```typescript
// src/index.ts

const discord = new LiveDiscordDataSource(bot);
const roomy = new LiveRoomyGateway(spaceManager);
const repo = BridgeRepository.open(dbPath);

// Services receive adapters, not raw DiscordBot/SpaceManager
runBackfill(discord, repo, roomy);
```

Tests create the adapters they need:

```typescript
// src/services/__tests__/backfill.test.ts

const discord = new FileDiscordDataSource("./gitignore/MuniTown");
const roomy = new MockRoomyGateway();
const repo = BridgeRepository.open(":memory:");

await runBackfill(discord, repo, roomy);

expect(roomy.eventsFor(spaceDid)).toHaveLength(expectedCount);
```

---

## Migration Order

| Step | What                                                 | Risk                                           | Value                             |
| ---- | ---------------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| 1    | Define `DiscordMessageData` + normalizers            | Low — mechanical                               | High — unblocks everything        |
| 2    | Define `DiscordDataSource` interface                 | Low — new file                                 | High — enables file-based testing |
| 3    | Implement `LiveDiscordDataSource`                    | Medium — must handle all Discordeno edge cases | High — production adapter         |
| 4    | Implement `FileDiscordDataSource`                    | Medium — pagination logic, indexing            | High — offline debugging          |
| 5    | Define `RoomyGateway` interface + `MockRoomyGateway` | Low — new file                                 | High — clean test assertions      |
| 6    | Refactor `backfill.ts`                               | High — most complex service                    | High — biggest testing win        |
| 7    | Refactor `message-ingestion.ts`                      | Medium — swap types + gateway                  | High — core transform testable    |
| 8    | Refactor `room-sync.ts`                              | Medium — channel discovery moves               | Medium                            |
| 9    | Refactor remaining services                          | Low — mechanical                               | Medium                            |
| 10   | Wire `index.ts` with adapters                        | Low — assembly                                 | High — production ready           |

---

## Files to Create

```
src/discord/data.ts              — DiscordMessageData, DiscordUserData, etc.
src/discord/data-source.ts       — DiscordDataSource interface
src/discord/live-data-source.ts  — LiveDiscordDataSource (wraps DiscordBot)
src/discord/file-data-source.ts  — FileDiscordDataSource (reads JSON exports)
src/discord/fake-data-source.ts  — FakeDiscordDataSource (wraps faker generator)
src/roomy/gateway.ts             — RoomyGateway interface
src/roomy/live-gateway.ts        — LiveRoomyGateway (wraps SpaceManager)
src/roomy/mock-gateway.ts        — MockRoomyGateway (in-memory event capture)
```

## Files to Modify

```
src/services/backfill.ts              — accept DiscordDataSource + RoomyGateway
src/services/message-ingestion.ts     — accept DiscordMessageData + RoomyGateway
src/services/room-sync.ts             — accept DiscordDataSource + RoomyGateway
src/services/profile-sync.ts          — accept RoomyGateway
src/services/reaction-sync.ts         — accept RoomyGateway
src/services/message-edit-delete.ts   — accept RoomyGateway
src/index.ts                          — wire adapters
```

## Files That Stay the Same

```
src/db/repository.ts       — already well-abstracted
src/db/schema.ts           — schema definition
src/discord/types.ts       — Discordeno desired properties (still needed for live adapter)
src/discord/cache.ts       — proxy cache setup (still needed for live adapter)
src/discord/slash-commands.ts  — Discord interaction handlers (not service logic)
src/utils/hash.ts          — pure utility
src/utils/emoji.ts         — pure utility
src/logger.ts              — logging
src/scripts/               — scripts (not service logic)
```
