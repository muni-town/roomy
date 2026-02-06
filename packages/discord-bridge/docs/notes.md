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

# Clean messages from Roomy-synced channels only
pnpm tsx scripts/run-cleanup.ts messages

# Delete all Roomy-synced channels
pnpm tsx scripts/run-cleanup.ts channels

# Clean messages, then delete channels (full cleanup)
pnpm tsx scripts/run-cleanup.ts all
```

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
