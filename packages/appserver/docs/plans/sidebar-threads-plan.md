# Sidebar Threads Plan

**Date:** 2026-06-01
**Status:** Plan
**Parent doc:** `appserver-architecture.md`

## Problem

Currently, `app-lite` shows threads under a channel in the sidebar **only when that channel is selected** and **only threads belonging to that channel**. This means threads appear/disappear as the user navigates between channels, making it hard to keep track of active conversations.

**Target behaviour (Discord model):**

- A small, persistent set of threads (max **8**) is always visible in the sidebar, regardless of which channel is active.
- These are threads the user has **recently interacted with** (last **72 hours**).
- "Interaction" means: the user **sent a message** in the thread or **added a reaction** to a message in the thread. Simply reading/viewing the thread does not count.
- The set persists across channel navigation within the same space.

## Design

### New table: `user_thread_activity`

In the **readstate database** (`data/roomy-readstate.sqlite`), add:

```sql
create table if not exists user_thread_activity (
  user_did      text not null,
  thread_id     text not null,
  last_active_at integer not null,   -- unix epoch milliseconds
  updated_at    integer not null default (unixepoch() * 1000),
  primary key (user_did, thread_id)
) strict;

create index if not exists idx_user_thread_activity_user
  on user_thread_activity(user_did, last_active_at desc);
```

This table is appserver-owned state — it cannot be reconstructed from the Leaf event log (interaction events are appserver-local). Bump the schema version constant in `readStateDb.ts`.

### When to upsert `last_active_at`

| Trigger | Where to hook | Condition |
|---------|--------------|-----------|
| User sends a message in a thread | `applyBundle.ts` — the existing `createMessage.v0` handler | `bundle.event.$type === "space.roomy.message.createMessage.v0"` AND the entity's `room` is a thread (check `comp_room.label`). Upsert `(author, threadId, now)`. |
| User adds a reaction in a thread | `applyBundle.ts` — add hook alongside the existing reaction materialisation | `bundle.event.$type === "space.roomy.message.addReaction.v0"` AND the message's `room` is a thread. Upsert `(reactor, threadId, now)`. |

**Thread detection:** in both hooks, check whether `comp_room.label = 'space.roomy.thread'` for the target `roomId`.

**Bulk initialisation on join:** When a user joins a space, backfill `user_thread_activity` rows from messages the user authored in threads (within the 72h window). This gives them an immediate populated sidebar without needing to write a new message first.

### Thread access filtering

Threads with `comp_room.deleted = 1` are excluded. Threads the user can no longer read (admin removed, `default_access` changed to `none`, no matching role grant) are also excluded — the endpoint filters by `roomAccess(db, threadId, userDid).canRead`.

### New or modified XRPC endpoint

**Add `activeThreads` to each channel object within `space.roomy.space.getMetadata.sidebar`.**

Rationale:
- The sidebar component already fetches `space.getMetadata` for the channel/category tree. Adding active threads there avoids a separate round-trip.
- Nesting threads under their parent channel preserves the hierarchy — the rendering loop already iterates channels within categories, so it can render visible threads underneath each channel inline.
- `activeThreads` is user-scoped (depends on caller's DID) like the existing `canRead`/`canWrite` fields.

**Modified response shape** (additions shown):

```typescript
// In space.roomy.space.getMetadata response:
{
  // ...existing fields...
  sidebar: {
    categories: Array<{
      id: string;
      name: string;
      position: number;
      channels: Array<{
        id: string;
        name: string;
        defaultAccess: "readwrite" | "read" | "none";
        canRead: boolean;
        canWrite: boolean;
        unreadCount: number;
        lastRead: string | null;
        activeThreads: Array<{           // NEW — always-visible threads for the sidebar
          id: string;
          name: string | null;
          activity: {
            latestTimestamp: string | null;
            latestMembers: Array<{
              did: string;
              name: string | null;
              avatar: string | null;
            }>;
          };
          canRead: boolean;
          canWrite: boolean;
          unreadCount: number;
          lastRead: string | null;
        }>;
      }>;
    }>;
    orphans: Array<{ /* same channel shape with activeThreads */ }>;
  };
}
```

Channels that have no active threads simply have an empty `activeThreads` array — no extra rendering.

**Query logic (server-side):**

Step 1 — find relevant threads for this user+space, up to the global limit of 8:

```sql
select uta.thread_id, uta.last_active_at
from user_thread_activity uta
join entities e on e.id = uta.thread_id
join comp_room cr on cr.entity = uta.thread_id
where uta.user_did = ?
  and uta.last_active_at > ?          -- 72h threshold in ms
  and cr.label = 'space.roomy.thread'
  and coalesce(cr.deleted, 0) = 0
  and e.stream_id = ?                 -- spaceId
order by uta.last_active_at desc
limit 8
```

Step 2 — for each result, resolve metadata:
- `comp_info.name`
- `latestTimestamp` + `latestMembers` (via new helper `resolveThreadsByIds`)
- `canRead` / `canWrite` via `roomAccess(db, threadId, userDid)`
- `unreadCount` / `lastRead` via `getReadPosition(db, userDid, threadId)`
- Parent channel via the `link` edge with `canonical_parent = 1`

Step 3 — distribute threads into channels:
- Group resolved threads by `canonicalParent` (the parent channel ID).
- For each channel in the sidebar tree (`categories[].channels[]` and `orphans[]`), if it has any matching threads, set `channel.activeThreads = groupedThreads[channel.id]`, sorted by last activity descending.
- Any threads whose parent channel is not in the sidebar (e.g. channel was deleted or user lost access) are filtered out — they wouldn't be navigable from the sidebar anyway.

**Existing helper reuse:** The `listThreadActivity` function in `queries/threadActivity.ts` already resolves `latestTimestamp`, `latestMembers`, and `canonicalParent` for given thread IDs. Add a new helper `resolveThreadsByIds(db, threadIds)` that reuses the same prepared statements for batch resolution.

### Invalidation signals

When `user_thread_activity` changes for a user (new message sent or reaction added), emit:

```typescript
{
  kind: "queryInvalidation",
  signal: {
    nsid: "space.roomy.space.getMetadata" as QueryNsid,
    params: { spaceId },
    affectedUser: userDid,  // scope to this user only
  },
}
```

This re-fetches `getMetadata` (including the new `activeThreads` sidebar fields) for the affected user.

Invalidation is scoped to the specific user (`affectedUser`), so other connected users are not affected — `activeThreads` is per-user data.

### SDK schema update

Add the `activeThreads[]` field to the `SidebarChannel` type in the `space.roomy.space.getMetadata` lexicon. The existing `getMetadata` response already has an extensible shape — this adds the new array to each channel object within `sidebar.categories[].channels[]` and `sidebar.orphans[]`.

## Client-side changes

### Data flow

1. `SpaceSidebar.svelte` reads `metaQuery.data.sidebar` (the existing sidebar object), which now includes `activeThreads` on each channel.
2. Inside the channel rendering loop, render thread children under each channel — always visible, regardless of which channel is active.
3. The threads belonging to each channel appear nested beneath it, matching Discord's visual hierarchy.

### Channel rendering adaptation

In `SpaceSidebar.svelte`, the `channelItem` snippet currently includes:

```svelte
{#if !isEditing && isActive && roomMetaQuery.data?.recentThreads?.length}
  <LinkedRoomList ... />
{/if}
```

**Remove this per-channel conditional rendering.** Instead, inside the channel item render, always show the channel's `activeThreads` when present and not in editing mode:

```svelte
{#snippet channelItem(channel: SidebarChannel)}
  {@const isActive = activeChannelId === channel.id}
  <div class={!channel.canRead ? "opacity-50 pointer-events-none" : ""}>
    <SidebarItemShell
      variant="channel"
      name={channel.name ?? channel.id}
      href={`/${spaceId}/${channel.id}`}
      active={isActive}
      hasUnreadDot={channel.unreadCount > 0}
      unreadCount={channel.unreadCount}
      showUnreadCount={channel.unreadCount > 0}
    />
    {#if !isEditing && channel.activeThreads?.length}
      <LinkedRoomList
        rooms={channel.activeThreads.map(t => ({
          id: t.id,
          name: t.name ?? t.id,
          unreadCount: t.unreadCount,
          lastRead: t.lastRead ? new Date(t.lastRead).getTime() : -1,
        }))}
        currentRoomId={page.params.room}
        showUnreadCount={true}
        hrefFor={(threadId) => `/${spaceId}/${threadId}`}
      />
    {/if}
  </div>
{/snippet}
```

Key differences from current code:
- No more `isActive` gate — threads show under their parent channel regardless.
- No more dependency on `roomMetaQuery` (the per-room `getMetadata` call) for sidebar thread rendering.
- The `LinkedRoomList` is embedded inside each channel, so the visual nesting is preserved.

### Sidebar channel type update

The `SidebarChannel` type (from the SDK schema) needs the new `activeThreads` field added. The `LinkedRoomList` component needs no changes — it already accepts `rooms`, `currentRoomId`, `showUnreadCount`, and `hrefFor`.

### Room-level metadata (`room.getMetadata`)

The existing `recentThreads` field on `room.getMetadata` is still useful — it provides channel-scoped recent threads for the `LinkedRoomList` shown **inside** the chat area (the thread list that appears next to the message input). The sidebar threads are separate from this. Both can coexist.

When the user clicks a thread's sidebar entry, `LinkedRoomList` already navigates to `/${spaceId}/${threadId}`.

### `room.getMetadata` per-channel recent threads

The `room.getMetadata.recentThreads` field should be **removed from the sidebar rendering** entirely (the old conditional in `channelItem` is deleted). It can stay in the API response for potential in-chat use. The new `activeThreads` on sidebar channels replaces it for sidebar purposes.

## Migration

### Backfill for existing users

On first deploy, existing `user_thread_activity` rows will be empty. Add a backfill query that runs lazily on the first `getMetadata` call for a user+space with no rows:

```sql
-- Backfill from messages the user authored in threads
insert or ignore into readstate.user_thread_activity (user_did, thread_id, last_active_at, updated_at)
select distinct author_e.tail, e.room, max(cc.timestamp), (unixepoch() * 1000)
from entities e
join comp_content cc on cc.entity = e.id
join edges author_e on author_e.head = e.id and author_e.label = 'author'
join comp_room cr on cr.entity = e.room and cr.label = 'space.roomy.thread'
where author_e.tail = ?
  and e.stream_id = ?
  and cc.timestamp > ?
group by author_e.tail, e.room
```

Where `?` is `(userDid, spaceId, now - 72h)`.

Or simpler: do it at `user_thread_activity` query time — if the user has no rows yet for this space, run the backfill before the main query.

### Purging stale rows

Rows older than 72 hours are filtered by the query, so they accumulate slowly. A periodic cleanup is optional:

```sql
delete from readstate.user_thread_activity
where last_active_at < ?  -- now - 72h
```

This can run once per hour in a background interval in `index.ts`, or be a maintenance script. The index on `(user_did, last_active_at desc)` makes the DELETE cheap.

## Estimated changes

| Area | Files changed | Effort |
|------|--------------|--------|
| Schema | `readStateSchema.sql`, `readStateDb.ts` | Small |
| DB helper | New `queries/userActiveThreads.ts` | Medium |
| Hook: createMessage | `applyBundle.ts` | Small |
| Hook: addReaction | `applyBundle.ts` adjacent to existing reaction materialisation | Small |
| XRPC handler | `space.getMetadata.ts` — query thread activity & distribute into channel objects | Medium |
| Thread activity helper | `queries/threadActivity.ts` (add `resolveThreadsByIds`) | Small |
| SDK schema | Lexicon `getMetadata` — add `activeThreads[]` to `SidebarChannel` | Small |
| Invalidation | Add signal at both hook points | Small |
| Client | `SpaceSidebar.svelte` — remove per-channel conditional, render `activeThreads` inline | Medium |
| Migration | Backfill on first query | Small |
| **Total** | ~10–12 files | **2–3 days** |

## Open questions

1. **Interaction scope — resolved.** Interaction is strictly: sending a message in a thread, or adding a reaction to a message in a thread. Read/view actions are excluded. This mirrors Discord's model where passive browsing doesn't promote a thread into your active sidebar.

2. **Max 8 limit — should this be configurable?** Start with a hardcoded constant. Make it a DB config or env var later if needed.

3. **72h window — configurable?** Same as above. Start with a constant; promote to env var when requested.

4. **Should threads in the sidebar show the parent channel name for context?** Discord does this. If so, include `channelName` in the response alongside `channelId`. The sidebar item could show "thread-name (in # channel-name)".