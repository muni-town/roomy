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
