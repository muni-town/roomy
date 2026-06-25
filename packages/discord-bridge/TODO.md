# Discord Bridge — Two-Way Bridging Follow-Ups

Remaining items from the code review of the Roomy→Discord direction.

## Done in this follow-up

- [x] **Add tests for `RoomyEventRouter`** — `src/services/__tests__/roomy-event-router.test.ts` covers create/edit/delete/reaction, echo prevention, unbridged rooms, profile attribution, `subscribeToSpace`, and x-dmp-patch skipping.
- [x] **Ignore `text/x-dmp-patch` edits** — `RoomyEventRouter` now skips edit events with unsupported MIME types instead of sending blank content to Discord.
- [x] **Use Discordeno webhook helper** — `LiveDiscordSender` now uses `bot.helpers.executeWebhook(..., { wait: true })` so rate-limiting and retries are handled by Discordeno.
- [x] **Handle null webhook token** — `LiveWebhookManager.ensureWebhook` deletes tokenless webhooks and throws a clear error instead of persisting an unusable empty token.
- [x] **Log `Promise.allSettled` subscription failures** — `RoomyEventRouter.start()` now logs each space subscription that rejects.
- [x] **Fix profile cache eviction** — `LiveProfileResolver` now maintains a true LRU cache by re-inserting accessed entries and evicting the oldest key.
- [x] **Fix `removeWebhook` error handling** — `LiveWebhookManager.removeWebhook` now keeps the repo token row if webhook deletion fails, making removal retryable.
- [x] **Include Discord error body in webhook failures** — `executeWebhook` failures now propagate Discord's response context through Discordeno's error path.

## Roomy→Discord thread sync

- [ ] **Nested Roomy threads are not supported** — `#handleCreateRoomLink` only resolves the parent room as a Discord `channel`. If Roomy ever allows a thread inside another thread, the parent thread mapping would be ignored and no Discord thread would be created.

## Functional gaps

- [ ] **Forward attachments from Roomy to Discord** — The router only decodes the text body (`decodeBody`). Roomy messages with image/video/file attachments (`space.roomy.extension.attachments.v0`) are silently dropped. Media-only messages send an empty Discord message. The Discord webhook API supports `attachments` and `embeds` fields that could be used.

- [ ] **Implement `removeReaction` in the router** — `#handleRemoveReaction` is currently a no-op. The `removeReaction` event only has `reactionId` (the ULID of the original `addReaction` event), not the emoji string needed to remove the reaction from Discord. Options:
  1. Store the emoji in a reaction mapping when bridging `addReaction`.
  2. Query the Leaf server for the original `addReaction` event to recover the emoji.

  When this is implemented, `handleReactionRemove` in `reaction-sync.ts` will also need a `botUserId` parameter (like `handleReactionAdd`) to prevent the bot from re-bridging its own reaction removals back to Roomy.

- [ ] **Handle empty-content Roomy messages** — If `decodeBody` returns `""`, the router still calls `sendMessage()` with empty content. For media-only messages this is wasted; for text-only messages it produces a blank Discord message. Skip or warn before sending (or wait until attachments are wired through).

## Robustness

- [ ] **Cursor freeze after failure requires restart** — When an event fails to bridge (e.g., Discord API error), the subscription cursor is frozen at the last successful position and stays frozen until the process restarts. Live events continue to be delivered (for UX) but the cursor doesn't advance, so on restart all events from the frozen position are re-delivered. The "already mapped" check prevents duplicate messages, but if the failure is permanent (e.g., invalid content), the cursor is stuck forever and every restart re-processes the same events. Consider adding a dead-letter mechanism or a maximum-retry count that allows the cursor to advance past permanently-failed events. Could store a `failure_count` in `space_cursors` and skip after N consecutive failures.

- [ ] **Consider backfill behavior for Roomy→Discord** — On first startup with 2-way bridging enabled, the router backfills ALL historical Roomy-native messages into Discord. For a brand-new Discord guild this is usually fine because Roomy rooms are created fresh for each Discord channel, so there is little pre-existing Roomy history. For an existing Roomy space being attached to an already-active Discord guild, however, this may flood Discord. Consider adding a config option to skip backfill (only bridge live messages going forward) or to rate-limit backfill delivery. The `isBackfill` meta flag is already received by the router but currently ignored.
