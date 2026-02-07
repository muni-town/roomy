# Discord Bridge - Implementation Notes

Notes for future developers working on the Discord bridge.

## Discord API Gotchas

### `bot.rest.getChannels()` Returns an Array, Not a Map

**Symptom:** Channel deletion fails with error 10003 "Unknown Channel" even though the channel exists.

**Cause:** `bot.rest.getChannels(guildId)` returns an `Array` of channel objects, not a `Map`. Using `.entries()` on an Array returns array indices (0, 1, 2...) instead of Discord snowflake IDs.

**Wrong:**
```typescript
const channels = await bot.rest.getChannels(guildId);
for (const [id, channel] of channels.entries()) {
  await bot.rest.deleteChannel(id);  // 'id' is array index, not Discord ID!
}
```

**Correct:**
```typescript
const channels = await bot.rest.getChannels(guildId);
for (const channel of channels) {
  await bot.rest.deleteChannel(BigInt(channel.id));  // Use channel.id from the object
}
```

**Fixed in:** `tests/e2e/helpers/setup.ts` - `cleanupRoomySyncedChannels()` function (2026-02-06)

---

## Testing Scripts

### Test Channel Operations
```bash
# List all channels with Roomy sync status
pnpm exec tsx scripts/test-delete-channel.ts list

# Delete a specific channel by ID
pnpm exec tsx scripts/test-delete-channel.ts delete <channel-id>

# Test delete the first Roomy-synced channel
pnpm exec tsx scripts/test-delete-channel.ts test-first
```

### Run Full Cleanup
```bash
# Delete all Roomy-synced channels from test guild
pnpm exec tsx scripts/run-cleanup.ts
```

---

## Environment Variables Required

| Variable | Description | Example |
|----------|-------------|---------|
| `TEST_GUILD_ID` | Discord guild ID for testing | `1465918107951562837` |
| `DISCORD_TOKEN` | Bot token | `MTM0MTUyOTA2Mjk4MzU5ODI1Q...` |

---

## Channel Type Constants

| Type | Value | Description |
|------|-------|-------------|
| GUILD_TEXT | 0 | Text channel |
| GUILD_VOICE | 2 | Voice channel |
| GUILD_CATEGORY | 4 | Category |
| GUILD_NEWS | 5 | News/announcement channel |
| GUILD_NEWS_THREAD | 11 | News thread |
| GUILD_PUBLIC_THREAD | 12 | Public thread |
| GUILD_FORUM | 15 | Forum channel |

---

## Message Deletion Behavior

### Webhook Messages Can Be Deleted by Bot

**Learning:** Webhook messages CAN be deleted by a bot with `MANAGE_MESSAGES` permission, even if the original webhook no longer exists.

**Contrary to initial assumption:** We initially thought webhook messages became "orphaned" when webhooks were deleted, making them impossible to clean up. However, testing revealed that `bot.helpers.deleteMessage()` successfully deletes webhook messages as long as the bot has the `MANAGE_MESSAGES` permission.

**Code:**
```typescript
// This works for both regular bot messages AND webhook messages
await bot.helpers.deleteMessage(channelId, messageId);
```

**Key distinction:**
- **Webhook deletion via token** (preferred when webhook exists): `bot.helpers.deleteWebhookMessage(webhookId, webhookToken, messageId)`
- **Bot deletion with MANAGE_MESSAGES** (fallback): `bot.helpers.deleteMessage(channelId, messageId)`

**Cleanup script behavior:** The `cleanupWebhookMessages()` function tries direct deletion first, then falls back to webhook-based deletion if the webhook still exists.

---

### Discordeno "InvalidBucket" Warnings

**Symptom:** Discordeno logs `[InvalidBucket] an invalid request was made` warnings, but the request still succeeds.

**Cause:** Discordeno's rate limiter throws this warning for REST-only bots (bots without gateway connection). The warning is a false positive - the actual HTTP request succeeds.

**Impact:** These warnings can be ignored. They don't indicate actual failures.

**Example:**
```
[105m[30m[2/6/2026 10:24:12 PM][39m[49m [33mWARN[39m Discordeno > [InvalidBucket] an invalid request was made. Increasing invalidRequests count to 1
✅ Deleted 18 webhook messages  # Deletion succeeded despite warning!
```

---

## Cleanup Scripts

### Available Cleanup Modes

```bash
# Clean webhook messages from ALL text channels (not just Roomy-synced)
pnpm tsx scripts/run-cleanup.ts webhooks

# Clean bot messages from ALL text channels (not just Roomy-synced)
pnpm tsx scripts/run-cleanup.ts bot

# Clean messages from Roomy-synced channels only
pnpm tsx scripts/run-cleanup.ts messages

# Delete all Roomy-synced channels
pnpm tsx scripts/run-cleanup.ts channels

# Clean webhook+bot messages from ALL channels, then delete channels (full cleanup)
pnpm tsx scripts/run-cleanup.ts all
```

**Note (2026-02-07):** The default "all" mode was updated to clean webhook and bot messages from ALL text channels (not just Roomy-synced ones). This catches strays in non-synced channels like #general that may accumulate during testing.

### safeDeleteWebhook() Helper

**Purpose:** Prevent orphaned webhook messages by deleting webhook messages before the webhook itself.

**Usage:**
```typescript
import { safeDeleteWebhook } from "../tests/e2e/helpers/setup.js";

// Deletes all webhook messages, then the webhook
const messagesDeleted = await safeDeleteWebhook(bot, channelId, webhookId);
```

**When to use:** When deleting webhooks during test cleanup or channel operations.

---

## Webhook vs Bot Message Detection

**Webhook messages have `message.webhookId` set:**
```typescript
if (message.webhookId) {
  // This is a webhook message
  const webhook = await bot.rest.getChannelWebhooks(channelId);
  const matchingWebhook = webhook.find(w => w.id === message.webhookId.toString());
} else {
  // This is a regular bot/user message
}
```

**Author display:**
- Webhook messages: `author.username` is the webhook's configured name (e.g., "Roomy User")
- Bot messages: `author.username` is the bot's name (e.g., "Roomy Bridge")
- Both have `author.bot === true`

---

## E2E Testing (2026-02-07)

### Structure Sync: Preserving Roomy-Native Rooms

**Problem:** When syncing Discord channels to Roomy, the sidebar was being completely replaced, losing existing Roomy rooms (like 'lobby') that weren't synced from Discord.

**Solution:** Modified `StructureSyncService.syncFullDiscordSidebar()` to:
1. Fetch all `createRoom` events to identify rooms without `discordOrigin` extension
2. Add a "Roomy" category containing all preserved rooms
3. Then append Discord categories below

**Code changes:**
```typescript
// In syncFullDiscordSidebar():
const allEvents = await this.connectedSpace.fetchEvents(1 as any, 1000);
const preservedRoomIds = new Set<Ulid>();

for (const { event } of allEvents) {
  if (event.$type === "space.roomy.room.createRoom.v0") {
    const e = event as any;
    const hasOrigin = DISCORD_EXTENSION_KEYS.ROOM_ORIGIN in (e.extensions || {});
    const isChannel = e.kind === "space.roomy.channel";

    if (isChannel && !hasOrigin) {
      // Roomy-native channel (like 'lobby'), preserve it
      preservedRoomIds.add(e.id);
    }
  }
}

// Add preserved Roomy rooms first (in a "Roomy" category)
if (preservedRoomIds.size > 0) {
  sidebarCategories.push({
    name: "Roomy",
    children: Array.from(preservedRoomIds),
  });
}
```

### Reverse Sync: Roomy → Discord Structure Backfill

**Problem:** Existing Roomy rooms (without Discord channels) weren't being synced to Discord during bridge initialization.

**Solution:** Added `backfillRoomyStructureToDiscord()` function in `backfill.ts`:
1. Fetches the current sidebar from Roomy
2. Triggers `handleRoomyUpdateSidebar()` to create Discord channels for Roomy-native rooms
3. Called as "Phase 0" of Roomy → Discord backfill (before message sync)

### Database Robustness Improvements

**Problem:** E2E tests were failing with "Database is not open" errors when run together, due to LevelDB state issues between test files.

**Solutions applied:**
1. Made `clear()` function catch and ignore database errors
2. Made `register()` function update existing registrations instead of throwing conflicts
3. This allows tests to re-use the same guild with different spaces

### Test Results

**When run individually (clean database each time): 49/64 tests pass (76.6%)**

| Suite | Passed | Total | Notes |
|-------|--------|-------|-------|
| basic-sync | 10 | 17 | 6 skipped, includes structure sync tests |
| edge-cases | 4 | 6 | 1 skipped |
| idempotency | 5 | 5 | All passing! |
| message-sync | 7 | 9 | 2 skipped |
| profile-sync | 7 | 7 | All passing! |
| reaction-sync | 6 | 6 | All passing! |
| reset-validation | 5 | 5 | All passing! |
| reverse-sync | 5 | 9 | 4 skipped |

### Known Issue: Running All Tests Together

Tests fail when run all together (`pnpm test:run tests/e2e`) due to LevelDB database state issues between test files. The database gets closed or corrupted after the first test file completes.

**Workaround:** Run tests individually:
```bash
# Run specific test file
rm -rf data/
pnpm test:run tests/e2e/suites/basic-sync.test.ts
```

**Potential fixes for future:**
- Run each test file in a separate process with isolated databases
- Implement proper database pooling/lifecycle management
- Use an in-memory database for testing
- Disable `clear()` in `beforeEach` and rely on unique test spaces instead

### Untracked Test Files

The following E2E test files are new and not yet tracked in git:
- `tests/e2e/suites/edge-cases.test.ts`
- `tests/e2e/suites/idempotency.test.ts`
- `tests/e2e/suites/message-sync.test.ts`
- `tests/e2e/suites/profile-sync.test.ts`
- `tests/e2e/suites/reaction-sync.test.ts`
- `tests/e2e/suites/reverse-sync.test.ts`

---
