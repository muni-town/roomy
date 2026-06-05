# Activity Feed Endpoint

**Endpoint:** `space.roomy.space.getActivityFeed` (query)
**File:** `packages/appserver/src/handlers/space.roomy.space.getActivityFeed.ts`

## Purpose

Returns a paginated, chronologically-ordered feed of recent activity across a user's spaces. One item per room (channel or thread), with up to 5 most recent messages and unread counts.

## Request

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `spaceId` | string | no | all joined spaces | Filter to a single space |
| `limit` | int (string-encoded) | no | 50 | Items per page (1–100) |
| `cursor` | string | no | — | Opaque cursor from previous response |

## Response

```typescript
{
  feed: Array<{
    threadId: string;          // room ULID
    threadName?: string;       // room name (comp_info.name)
    spaceId: string;           // space DID
    spaceName?: string;
    spaceAvatar?: string;
    channelId?: string;        // parent channel (thread items only)
    channelName?: string;
    lastActivityAt: string;    // ISO 8601
    activityType: "message";   // reserved for future types
    messages: Array<{
      id: string;
      content: string;         // raw markdown, no truncation
      author: { did: string; name?: string; avatar?: string };
      timestamp?: string;      // ISO 8601
    }>;
    unreadCount: number;
  }>;
  cursor?: string;             // present when more pages available
}
```

## Key behaviours

- **One item per room** — channels and threads each get their own row. Thread items include `channelId`/`channelName` for rendering context (e.g. "in #general").
- **Newest-first** — sorted by `lastActivityAt` descending. Ties broken by `roomId` descending.
- **Cursor pagination** — pass the `cursor` from the previous response to get the next page. Cursor format is `{timestamp}::{roomId}` (opaque to clients).
- **Unread counts** — per-room, from the read-state DB. Returns 0 for rooms with no readstate row.
- **Deleted rooms** — silently excluded.
- **Inaccessible rooms** — silently excluded (same access control as `getSpaceThreads`).
- **Deleted messages** — silently skipped. If all recent messages in a room are gone, the item still appears with an empty `messages` array.
- **Content** — raw markdown blob, no truncation. Client decides rendering.
- **`activityType`** — currently always `"message"`. Future types (`"reaction"`, `"thread_created"`, etc.) will be added by extending the materialisation hooks.

## Example flow

```
// Page 1
GET /xrpc/space.roomy.space.getActivityFeed?limit=20
→ { feed: [...20 items], cursor: "1717536000000::01J0XYZ..." }

// Page 2
GET /xrpc/space.roomy.space.getActivityFeed?limit=20&cursor=1717536000000::01J0XYZ...
→ { feed: [...20 items], cursor: "1717535900000::01J0ABC..." }

// Page 3 (no more pages)
GET /xrpc/space.roomy.space.getActivityFeed?limit=20&cursor=1717535900000::01J0ABC...
→ { feed: [...remaining items] }  // no cursor field
```

## Materialisation

Feed items are **materialised at write time** — every `createMessage.v0` event upserts a row in the `activity_item` table. No on-the-fly computation. The `recent_message_ids` column stores a JSON array of up to 5 most recent message ULIDs (newest first). Full message content is joined at query time, so edits to existing messages are reflected immediately.
