# LiveQuery Inventory

All `LiveQuery` instantiation sites in `packages/app/src`. Each row maps to a candidate XRPC procedure.

**Legend — Migration type:**
- `subscription` — high-churn or presence data; WebSocket stream of row diffs
- `query` — low-churn; HTTP GET, revalidated on demand or by subscription trigger
- `inline` — best absorbed into a parent query result rather than a dedicated endpoint

---

## Queries

| # | File | Variable | Tables touched | Data returned | XRPC candidate | Type | Notes |
|---|------|----------|---------------|---------------|----------------|------|-------|
| 1 | `queries/appState.svelte.ts:138` | `#spacesQuery` | `comp_space`, `comp_info`, `entities`, `edges`, `comp_user` | All joined spaces: id, name, avatar, description, permissions (member list with `can` field) | `roomy.space.subscribeSpaces` | subscription | Scoped to personal space stream (`getPersonalSpaceId()`). Low churn but must be live to reflect space joins/leaves. Handle resolution is done separately in a `$effect` and merged in client — could move to server. |
| 2 | `queries/spaceState.svelte.ts:83` | `#metadataQuery` | `comp_info` | Space name, avatar, description for a given `spaceId` | `roomy.space.getMetadata` | query | Simple single-row lookup. Changes rarely; a query with a subscription for invalidation is sufficient. One `SpaceState` per joined space is pre-warmed. |
| 3 | `queries/spaceState.svelte.ts:90` | `#sidebarQuery` | `comp_space`, `comp_info`, `comp_room`, `comp_last_read` | Sidebar tree: categories → channels with `unreadCount`, `lastRead` | `roomy.space.subscribeSidebar` | subscription | Complex JSON aggregation with `json_each` on stored `sidebar_config`. Unread counts change on every message read/receive — high churn. Orphan detection (channels not in any category) done in client by combining with `#allChannelsQuery` — should move to server. |
| 4 | `queries/spaceState.svelte.ts:122` | `#allChannelsQuery` | `entities`, `comp_room`, `comp_info`, `comp_last_read` | Flat list of all channels in a space: id, name, unreadCount, lastRead | (merged into #3) | — | Used only to detect "orphan" channels not pinned to a category. Can be eliminated if the server handles orphan detection and embeds orphans into the sidebar response. **No separate XRPC procedure needed.** |
| 5 | `components/thread/ChatArea.svelte:105` | `query` | `entities`, `comp_content`, `edges`, `comp_user`, `comp_info`, `comp_reaction`, `comp_embed_*`, `comp_comment`, `comp_discord_origin` | All messages in a room: full message objects with author, timestamp, reactions, media, links, tags, reply-to, forwarded-from | `roomy.room.subscribeMessages` | subscription | Most complex query in the codebase. UNION with forwarded messages (follows `forward` edge to original). Includes inline aggregation for reactions and media per message. High churn. Pagination (lazy load) must be modelled — server holds cursor state. |
| 6 | `routes/[space]/[object]/+page.svelte:78` | `roomQuery` | `entities`, `comp_info`, `comp_room`, `comp_last_read` | Room metadata: name, kind (label), spaceId, lastRead, unreadCount | `roomy.room.getMetadata` | query | Parameterised by `app.roomId`. `lastRead`/`unreadCount` change on message activity — may want a lightweight subscription or short-lived cache invalidation. |
| 7 | `routes/[space]/index/+page.svelte:26` | `threadsQuery` | `comp_room`, `comp_info`, `entities`, `comp_page_edits`, `comp_content`, `edges` | All pages + threads in a space for the board/index view: id, name, channel, activity (latest members + timestamp) | `roomy.space.getThreads` | query | UNION of pages and threads. Activity sub-query uses a window function (`row_number() over partition by`). Changes when threads are created or messages sent — moderate churn; poll or subscription. |
| 8 | `components/sidebars/LinkedRoomsList.svelte:22` | `query` | `entities`, `edges`, `comp_room`, `comp_info`, `comp_last_read` | Linked rooms for a given room (via `link` edge): name, id, unreadCount, lastRead | `roomy.room.getLinkedRooms` | query | Follows `link` edges from a parent entity; limited to 5 results, ordered by latest message. Updates when links are created or messages arrive. |
| 9 | `components/helper/EntityName.svelte:12` | `query` | `comp_info` | Single `name` string for any entity id | (inline) | inline | Extremely lightweight. Used as an inline label helper. Should be eliminated — parent queries should include names directly rather than issuing a separate query per entity. Could fall back to a `roomy.entity.getName` query call if truly needed in isolation, but that's a last resort. |
| 10 | `components/modals/EditRoomModal.svelte:44` | `roomQuery` | `comp_info`, `comp_room` | Room name and kind (channel/thread/page) for the edit modal | `roomy.room.getMetadata` | query | Same shape as #6 — can reuse the same endpoint. Only active when the modal is open. |
| 11 | `components/thread/boardView/ChannelBoardView.svelte:18` | `threadsList` | `comp_room`, `comp_info`, `entities`, `edges`, `comp_content`, `comp_user` | Threads within a specific channel (children via `link` edge): id, name, canonicalParent, activity | `roomy.room.getThreads` | query | Scoped to `page.params.object` (a channel). Sub-query uses `row_number() over (partition by author_edge.tail)`. Moderate churn; same activity model as #7 but per-channel rather than per-space. |
| 12 | `components/content/page/PageView.svelte:30` | `pageQuery` | `comp_content`, `comp_page_edits` | Latest page content (markdown blob) and `latestEditId` | `roomy.page.getContent` | query | Large data: full page markdown. Invalidated by edit events — subscription for invalidation trigger + fetch on change is cleaner than streaming the full content on every keystroke. |
| 13 | `components/content/page/PageHistory.svelte:17` | `historyQuery` | `comp_page_edits`, `comp_info` | All edits for a page: content blob, edit_id, mime_type, authorName, authorAvatar | `roomy.page.getHistory` | query | Full edit history — grows over time. Fetched once when history panel opens. No need for live subscription; snapshot at open time is acceptable. |
| 14 | `components/thread/message/MessageContextReply.svelte:16` | `query` | `entities`, `comp_content`, `edges`, `comp_user`, `comp_info` | Single message by id: content, authorDid, authorName, authorAvatar, timestamp | `roomy.message.getMessage` | query | Used to render reply preview in thread. One call per replied-to message visible on screen. With Tanstack DB, this may be satisfiable from the already-subscribed message cache without a separate request — only needed for messages outside the loaded window. |
| 15 | `queries/calendar.svelte.ts:12` | (from `calendarLinkQuery`) | `comp_calendar_link` | Calendar integration config: groupSlug, tenantId, apiUrl | `roomy.space.getCalendarLink` | query | External calendar integration data stored in a custom component table. Low churn. Likely a candidate for deferral — calendar feature may be re-evaluated in the new architecture. |
| 16 | `queries/calendar.svelte.ts:38` | (from `calendarEventsQuery`) | `comp_calendar_event` | All calendar events for a stream: entity, slug, name, dates, location, status, syncedAt | `roomy.space.getCalendarEvents` | query | Full event list, ordered by start date. Calendar feature may not be carried forward in the immediate migration. Low priority. |
| 17 | `queries/spaceState.svelte.ts:112` | `#joinPolicyQuery` | `comp_space` | `allow_public_join`, `allow_member_invites` for a space | (merged into `roomy.space.getMetadata`) | inline | Two-row scalar — folds into `getMetadata` as `joinPolicy`. |
| 18 | `queries/spaceState.svelte.ts:119` | `#adminQuery` | `edges` | Whether caller has the persistent `admin` edge on this space (admin ⊥ membership) | (caller-scoped on `roomy.space.getMetadata` and `roomy.space.getSpaces`) | inline | Drives `isSpaceAdmin`. Computed server-side as `isAdmin` on every relevant response. |
| 19 | `queries/appState.svelte.ts:145` | `#canWriteQuery` | `comp_room`, `edges`, `member_roles`, `role_rooms`, `roles` | Whether caller can post in a given room (admin OR `default_access=readwrite` OR matching `readwrite` role grant; threads inherit parent's `default_access`) | (caller-scoped on `roomy.room.getMetadata` as `canWrite`) | inline | Replaces the post-permission gate on `ChatInputArea`. Read access (`canRead`) follows the same union with `read` permitted. |
| 20 | `queries/spaceState.svelte.ts` (roles fetch) | `peer.fetchRoles` / `getRoles` | `roles`, `role_rooms`, `member_roles`, `members` | All roles in a space with their room permissions and assigned member DIDs | `roomy.space.getRoles` | query | Drives roles settings page and `EditRoomModal`'s role permission picker. Soft-deleted roles excluded. |
| 21 | (used in `RoleModal` / `UserTypeahead`) | `peer.fetchProfiles` / `members` query | `members`, `admins`, profile components | Space members + external admins with profile data | `roomy.space.getMembers` | query | Returns members and externalAdmins separately to preserve admin ⊥ membership. |
| 22 | `queries/spaceState.svelte.ts` (invites fetch) | `peer.fetchInvites` / `invites` | `invites`, `admins` | Active invite tokens — admins see all, members see own | `roomy.space.getInvites` | query | Drives `InviteModal`. Caller-scoped result set. |

---

## Summary by XRPC procedure

| Proposed procedure | Type | Source queries |
|--------------------|------|----------------|
| `roomy.space.subscribeSpaces` | subscription | #1 |
| `roomy.space.subscribeSidebar` | subscription | #3 + #4 merged |
| `roomy.room.subscribeMessages` | subscription | #5 |
| `roomy.space.getMetadata` | query | #2 |
| `roomy.room.getMetadata` | query | #6, #10 |
| `roomy.space.getThreads` | query | #7 |
| `roomy.room.getLinkedRooms` | query | #8 |
| `roomy.room.getThreads` | query | #11 |
| `roomy.page.getContent` | query | #12 |
| `roomy.page.getHistory` | query | #13 |
| `roomy.message.getMessage` | query | #14 (may be cache-hit) |
| `roomy.space.getCalendarLink` | query | #15 (low priority) |
| `roomy.space.getCalendarEvents` | query | #16 (low priority) |
| `roomy.space.getRoles` | query | #20 |
| `roomy.space.getMembers` | query | #21 |
| `roomy.space.getInvites` | query | #22 |
| ~~EntityName~~ | ~~inline~~ | #9 — eliminate |
| ~~joinPolicy / isSpaceAdmin / canWrite / canRead~~ | ~~inline~~ | #17, #18, #19 — folded into existing endpoints as caller-scoped fields |

**3 subscriptions, 11–13 queries.** The critical migration path is the 3 subscriptions (#1, #3, #5) — these are the high-churn, always-live queries that drive the majority of reactive UI updates. The new role/member/invite queries (#20–#22) are low-churn and tied to settings UIs, but their underlying state changes (role permission edits, admin edge changes) drive invalidation across many other endpoints — see `xrpc-interface-spec.md` § Invalidation Signal Routing.

---

## Key complexity notes

- **ChatArea (#5)** is the hardest query to port. It joins 10+ tables, includes a UNION for forwarded messages, and aggregates reactions/media/tags per message inline. Pagination (cursor-based lazy load) must be modelled in the XRPC subscription cursor semantics. Consider breaking the aggregated sub-selects into server-side joins resolved before streaming.
- **Sidebar (#3 + #4)** requires merging two query results client-side (orphan detection). This logic should move entirely to the server — the server returns a complete sidebar tree including orphans.
- **Unread counts** appear in sidebar (#3), room metadata (#6), and linked rooms (#8). They require per-user state keyed on `comp_last_read`. The server must be auth-aware to serve correct unread counts per caller.
- **EntityName (#9)** is a symptom of the current architecture's granular querying — in the target architecture, parent queries include names, making this unnecessary.
- **Calendar (#15, #16)** uses custom component tables (`comp_calendar_link`, `comp_calendar_event`) not present in the core schema. Worth confirming the feature is in scope before designing XRPC procedures.
- **Roles and per-room permissions (#19, #20)** require joining `roles`, `member_roles`, and `role_rooms` against the caller's DID for every room-access decision. The same union appears in `canWrite` (#19), the sidebar filter (#3), and read-access enforcement on `getMessages`/`getThreads`/`getMessage`. Implement as a shared SQL fragment or helper to avoid drift.
- **Admin orthogonality (#18, #21)** — admin and membership are independent edges. `getMembers` returns `members` and `externalAdmins` separately so callers can distinguish a "member with admin role" from an "admin who is not a member". Auth predicates throughout the appserver compute the **union** of admin-edge presence and member/role signals.
- **Caller-scoped fields** — `isMember`, `isAdmin`, `canRead`, `canWrite`, and the access-filtered sidebar are all caller-scoped. They cannot be pre-materialised into a per-space view; handlers compute them per request from the caller's DID. The TanStack Query cache is per-browser-session so this is safe.
