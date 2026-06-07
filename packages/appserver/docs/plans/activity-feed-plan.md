# Activity Feed Plan

**Date:** 2026-06-04
**Status:** Implemented
**Parent doc:** `appserver-architecture.md`

## Problem

The appserver currently has no endpoint for surfacing a unified, chronologically-ordered feed of recent activity across a user's spaces. The existing `getThreads` endpoints are scoped to a single space or room and return all threads (not just recently-active ones), making them unsuitable for a "recent activity" overview.

**Target behaviour:**

- A paginated feed of one item per room (channels and threads), ordered newest-first by last activity.
- Each item includes a preview of the most recent messages (up to 5), with full content (raw markdown, no truncation).
- Unread counts per room.
- Optional space-level filter; otherwise aggregates across all joined spaces.
- Cursor-based pagination for efficient incremental loading.

## Design

### New table: `activity_item`

In the **appserver database** (`data/roomy.sqlite`), add:

```sql
create table if not exists activity_item (
  room_id             text primary key not null,
  space_id            text not null,
  is_thread           integer not null default 0,
  parent_channel_id   text,
  parent_channel_name text,
  last_activity_at    integer not null,
  recent_message_ids  text not null default '[]',
  room_name           text,
  space_name          text,
  space_avatar        text,
  created_at          integer not null default (unixepoch() * 1000),
  updated_at          integer not null default (unixepoch() * 1000)
) strict;

create index if not exists idx_activity_item_space
  on activity_item(space_id, last_activity_at desc);

create index if not exists idx_activity_item_activity
  on activity_item(last_activity_at desc);
```

This table is **materialised at write time** — rows are upserted on every `createMessage.v0` event, not computed on-the-fly at query time. This keeps reads fast (single-table scan with optional space filter) and avoids expensive joins on every page load.

**Why not `comp_` prefix:** This is not an entity-component table — it's a derived projection. The `comp_` prefix is reserved for tables that mirror Leaf entity state.

### Materialisation strategy

**Trigger:** Every `createMessage.v0` event in `applyBundle.ts`.

**Fast path (existing row):**
1. Read the existing `recent_message_ids` JSON array.
2. Prepend the new message ID, deduplicate, cap at 5.
3. Update `last_activity_at` (decoded from the message ULID) and `updated_at`.

**Slow path (first message in room):**
1. Fetch denormalized metadata in a single query:
   - `comp_room.label` → determines `is_thread`
   - `comp_info.name` → `room_name`, `space_name`, `space_avatar`
   - `edges` with `label='link'` and `canonical_parent=1` → `parent_channel_id`, `parent_channel_name`
2. Insert the full row with the first message ID.

**Backfill:** The upsert runs during backfill too (events arrive in monotonically increasing `idx` order, so each new message is correctly prepended). No special backfill logic needed.

### Read path

**Query:** `selectActivityFeed(db, userDid, personalStreamDid, scope)`

Steps:
1. **Fetch raw rows** from `activity_item` with dynamic WHERE clause:
   - Space filter: `ai.space_id = ?` (specific) or `ai.space_id in (select tail from edges where head = ? and label = 'joinedSpace')` (all joined spaces)
   - Deleted room filter: `(cr.deleted is null or cr.deleted = 0)`
   - Cursor: `(ai.last_activity_at < ? or (ai.last_activity_at = ? and ai.room_id < ?))`
   - Order: `ai.last_activity_at desc, ai.room_id desc`
   - Limit: `scope.limit + 1` (one extra to detect "has more")
2. **Batch-fetch message data** — collect all message IDs from the page, query `entities` + `comp_content` + `edges` (author) in one `WHERE id IN (...)` query.
3. **Batch-fetch unread counts** — query `readstate.read_positions` for each room ID.
4. **Assemble feed items** — map each row to an `ActivityFeedItem`, skipping message IDs that no longer exist (deleted messages).
5. **Compute cursor** — if more pages exist, cursor = `"{last_activity_at}::{room_id}"` of the last item.

### Cursor format

```
{last_activity_at}::{room_id}
```

Example: `1717536000000::01J0XYZ...`

The cursor encodes both the timestamp and room ID to handle ties (same millisecond). Newest-first ordering means the cursor points to the last item on the current page — the next page fetches items strictly before that point.

### Access control

| Scenario | Behaviour |
|----------|-----------|
| `spaceId` param + user can't access space | 403 error |
| `spaceId` param + user can access space | Filter to that space only |
| No `spaceId` param | Aggregate across all joined spaces |
| Room user can't read | Silently excluded (same `roomAccess` check as `getSpaceThreads`) |

### Response shape

```typescript
{
  feed: Array<{
    threadId: string;
    threadName?: string;
    spaceId: string;
    spaceName?: string;
    spaceAvatar?: string;
    channelId?: string;       // parent channel for thread items
    channelName?: string;
    lastActivityAt: string;   // ISO 8601
    activityType: "message";  // forward-looking for future types
    messages: Array<{
      id: string;
      content: string;        // raw markdown, no truncation
      author: { did: string; name?: string; avatar?: string };
      timestamp?: string;
    }>;
    unreadCount: number;
  }>;
  cursor?: string;            // present when more pages available
}
```

**One item per room** — both channels and threads get their own row. Thread items include `channelId`/`channelName` for rendering context (e.g. "in #general").

**No content truncation** — message content is the raw markdown blob, passed through as-is.

**`activityType` field** — currently always `"message"`. Reserved for future expansion (reactions, thread creation, etc.).

## Files

### Created

| File | Purpose |
|------|---------|
| `packages/appserver/src/materialization/activityItem.ts` | `upsertActivityItem()` — write-side upsert logic (fast path + slow path) |
| `packages/appserver/src/queries/activityFeed.ts` | `selectActivityFeed()` — read-side query with batch message fetching, unread counts, cursor pagination |
| `packages/appserver/src/handlers/space.roomy.space.getActivityFeed.ts` | XRPC handler — validates auth, hydrates membership, checks access, delegates to query |
| `packages/sdk/src/schemas/queries/getActivityFeed.ts` | Arktype schema (Params, Response, ActivityItem, ActivityMessage, ActivityAuthor) |
| `packages/sdk/src/schemas/lexicons/space.roomy.space.getActivityFeed.json` | Auto-generated AT Protocol lexicon |

### Modified

| File | Change |
|------|--------|
| `packages/appserver/src/db/schema.sql` | Added `activity_item` table + indexes |
| `packages/appserver/src/db/db.ts` | Bumped `SCHEMA_VERSION` to `"7-appserver.9"` |
| `packages/appserver/src/materialization/applyBundle.ts` | Calls `upsertActivityItem` for every `createMessage.v0` event |
| `packages/appserver/src/index.ts` | Imported handler, registered `.query(...)` route with schema |
| `packages/sdk/src/schemas/queries/index.ts` | Added `getActivityFeed` re-export |
| `packages/sdk/scripts/generate-lexicons.ts` | Added `const` literal support for single string literal unions in lexicon generation |

## Key design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Table prefix | No `comp_` prefix | Not an entity-component table; it's a derived projection |
| Materialisation timing | Write-time (on `createMessage.v0`) | Keeps reads fast; avoids expensive on-the-fly computation |
| Message storage | Store IDs in JSON array, join at query time | Avoids stale content; message data always reflects latest edits |
| Window size | 5 most recent messages per room | Enough for a useful preview without excessive data transfer |
| Deduplication | One item per room | Covers both channels and threads; no per-user splitting |
| Pagination | Cursor = `"{timestamp}::{roomId}"` | Handles ties; efficient index-based pagination |
| Content format | Raw markdown blob | No truncation, no stripping — client decides rendering |
| Deleted rooms | Filtered via `comp_room.deleted` join | Silent exclusion, same as other endpoints |
| Backfill | Processed normally | Events arrive in order; no special backfill logic needed |

## Future considerations

1. **Additional activity types** — The `activityType` field is a string literal (`"message"`). Future types like `"reaction"` or `"thread_created"` can be added by extending the materialisation hooks and updating the schema union.

2. **Per-user activity items** — Currently items are per-room (shared between all users). If per-user personalisation is needed (e.g. "only show threads I've participated in"), a separate `user_activity_item` table could be added.

3. **Reaction activity** — When a reaction is added to a message, the parent room's activity item could be bumped. This would require adding a hook in the `addReaction.v0` materialisation path.

4. **Room creation activity** — Currently skipped (wait until first message). Could be added by materialising on room creation events with an empty messages array.

5. **Purging stale rows** — Rooms with no recent messages accumulate in the table. A periodic cleanup could delete rows where `last_activity_at` is older than a threshold (e.g. 30 days).
