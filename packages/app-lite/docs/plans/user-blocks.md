# User-level blocks — Implementation Plan

**Date:** 2026-09-26
**Status:** Draft — not started. No phase is dispatchable until Meri answers
Open Questions 1–3.
**Packages:** `packages/appserver`, `packages/app-lite`, `packages/design`,
`packages/sdk`, `packages/docs`

## Goal

A Roomy user can block another account. Messages from a blocked account are
hidden in the blocker's UI behind a subtle indicator, and **the content is not
revealable through any route** — not the room timeline, not search, not the
activity feed, not thread replies, not a bridged copy, not a push
notification, not a live WebSocket frame.

Blocking is set in two places:

1. **Bootstrap from Bluesky** — an account's existing `app.bsky.graph.block`
   records are imported so a new Roomy user does not have to re-block everyone.
2. **A new Roomy block record** — written when a user blocks in-app, so a user
   with no Bluesky presence can block, and so the block is portable to any
   Roomy client rather than trapped in one appserver's database.

Meri's stated UI: a small grey blocked-circle-X icon in the avatar position,
centred.

---

## Verified starting point

Everything below is verified against `origin/next` = `caa71df0` and against live
network endpoints on 2026-09-26. Facts are named with their source file and
line; network facts name the measurement.

**There is no block/mute/hide concept anywhere in the tree.** No table (checked
all five schema files), no SDK event in `eventRegistry`
(`packages/sdk/src/schema/events/registry.ts:54-98`), no XRPC route, no
query param, no UI. `app.bsky.graph.*` and `com.atproto.repo.listRecords`
appear nowhere. The only moderation primitive is a **space-scoped ban**
(`comp_bans`, `packages/appserver/src/db/schema-space.sql:295-301`), which is
space-admin-owned and has nothing to do with a per-viewer block.

**No per-viewer filtering exists in any read.** `selectMessages` takes
`viewerDid` and uses it for exactly one thing — `myReactionId`
(`packages/appserver/src/queries/selectMessages.ts:368`, `:467`). Every read is
filtered by *room read access* only. Live frames are built once per room topic
and sent to every authorised connection
(`packages/appserver/src/sync/handler.ts:494-537`).

### Message read path (what a block has to intercept)

| Piece | Location |
|---|---|
| Room-scope keyset SQL | `queries/selectMessages.ts:153-196` |
| `where` clause | `:185-186` — `e.room = ?1 and (cc.entity is not null or forward_e.tail is not null)` |
| Order + page size | `:194-195` — `order by e.sort_idx desc limit min(limit,100)` |
| Next cursor | `:566-574` — `baseRows.length === limit` → `nextCursor = messages[0].id` |
| Forward-original recursion | `:250-280` |
| Reactions / embeds / link data batches | `:285-290`, `:292-333`, `:415-420` |
| Profile hydration | `:539-548` |
| Handler | `handlers/space.roomy.room.getMessages.ts:34-38` (limit 1–100, default 50) |

The filter clause keeps exactly the message-shaped entities and has no
author predicate, so a block is a new predicate over the same rows.

### Every route that can carry a blocked author's content

This list is the no-reveal checklist. Each row is a distinct leak surface, not a
variation of one:

| # | Surface | Where | What leaks |
|---|---|---|---|
| 1 | Room timeline | `room.getMessages` → `selectMessages` room scope | Full DTO |
| 2 | Single message | `message.getMessage:44` | Full DTO by id |
| 3 | Search hits | `handlers/space.roomy.search.messages.ts:306-316` | Full DTO |
| 4 | Search reply context | same file `:345` | Full DTO |
| 5 | Activity feed messages | `queries/activityFeed.ts:320-360` | Up to 5 msgs/room |
| 6 | Activity feed participants | `queries/activityFeed.ts` `latestMembers` | Name + avatar |
| 7 | Board previews | `queries/threadActivity.ts:424-447` | `latestMessage.content` |
| 8 | Board participants | same, `latestMembers` | Name + avatar |
| 9 | Mentions | `handlers/space.roomy.mention.getMentions.ts`, `queries/mentions.ts:294-300` | Full DTO |
| 10 | Link index | `handlers/space.roomy.room.getLinks.ts`, `queries/links.ts` | Message id + URL |
| 11 | Reactions | `handlers/space.roomy.message.getReactions.ts` | Reactor name/avatar |
| 12 | Live message diff | `sync/handler.ts:494-518` | Full DTO |
| 13 | Live activity diff | `sync/handler.ts:554-579` | Author + preview text |
| 14 | Live unread diff | `sync/handler.ts:610-645` | A blocked message bumping unread |
| 15 | Live mention frame | `sync/handler.ts:581-608` | Full DTO |
| 16 | Raw stream events | `sync/handler.ts:963-990` | Unredacted event body |
| 17 | Push payloads | `push/evaluate.ts` + app-lite `lib/notificationText.ts` | Author name + text |
| 18 | Unread counters | `materialization/applyBundle.ts:184-204` | Blocked msg counted as unread |
| 19 | Forwarded copies | `selectMessages.ts:508-519` `forwardedFrom.message` | Original DTO |
| 20 | Reply previews | `MessageContextReply.svelte`, `SearchResultsList.svelte:368-412` | Author + snippet |
| 21 | Client cache | `getMessages` TanStack cache, `staleTime: Infinity` | Previously-fetched row |

Surfaces 19–21 are the ones a server-only design forgets: a forward embeds a
*different* author's full DTO (`selectMessages.ts:250-280`), the search list
renders its own reply-preview markup duplicated from `MessageContextReply`
(`SearchResultsList.svelte:368-412`), and `staleTime: Infinity`
(`lib/client.ts:19-28`) means a row fetched before the block survives in the
browser cache until the server sends a diff or the query refetches.

---

## 1. Lexicon design

### 1.1 The record

New record lexicon `space.roomy.user.block`, added as
`packages/appserver/lexicons/space/roomy/user/block.json`, beside the existing
`profile.json` and following its shape (record `main`, `description` stating
what the record means, `required` naming the mandatory fields — compare
`packages/appserver/lexicons/space/roomy/user/profile.json`, which omits
`required` because nothing is mandatory, and `service.json`, which requires
`did`):

```json
{
  "lexicon": 1,
  "id": "space.roomy.user.block",
  "defs": {
    "main": {
      "type": "record",
      "description": "A user's block of another account, written to the blocking user's own repo. Blocks hide the blocked account's messages from the blocker. The record is public: atproto repositories are world-readable, and app.bsky.graph.block — the source of the Bluesky bootstrap — is public for the same reason.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "createdAt"],
        "properties": {
          "subject": {
            "type": "string",
            "format": "did",
            "description": "DID of the blocked account. May be an atproto DID or a bridged did:discord:<snowflake>."
          },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

**`key: "tid"`.** One record per block, appended with a fresh TID (an atproto
record-key type — `https://atproto.com/specs/record-key`). This mirrors
`app.bsky.graph.block`, whose real lexicon (fetched from
`bluesky-social/atproto`) is:

```json
{ "key": "tid",
  "record": { "type": "object", "required": ["subject", "createdAt"],
    "properties": {
      "subject": { "type": "string", "format": "did" },
      "createdAt": { "type": "string", "format": "datetime" } } } }
```

The mirroring is deliberate and load-bearing: the two collections are
field-for-field convertible, so the bootstrap is a copy rather than a
translation, and a future migration in either direction is mechanical.

The alternative — `key: "literal:self"` with a `subjects: string[]` array, like
`profile.json` — is rejected: it is a read-modify-write on every block, two
devices blocking concurrently lose one of the blocks, and it destroys the
per-block `createdAt` that a "when did I block this person" affordance needs.

**Author:** the blocking user. The record lives in their own repo at
`at://<blocker-did>/space.roomy.user.block/<tid>`.

**Indexing:** none in the appserver. `space.roomy.user.block` is not a space
stream, so the materialiser never sees it — exactly as with
`space.roomy.user.profile`, which the appserver reads **on demand from the PDS**
rather than materialising (`packages/appserver/src/materialization/roomyProfile.ts:88-100`,
`getRoomyProfileRecord`). The appserver reads the block collection the same
way (§2).

### 1.2 Public repo record, not private, not local-only

**It is a public repo record.** There is no such thing as a private record in
atproto — every record in a repository is world-readable via
`com.atproto.repo.listRecords` and (for firehose subscribers) the raw events
themselves. The three real options and their consequences:

| Option | Cross-app blocking | Consequence |
|---|---|---|
| **Public repo record** (chosen) | Works: any Roomy client can read the blocker's repo and enforce the same set | The block list is world-readable, and the blocked account can learn it is blocked |
| Appserver-only (readstate table) | Does not work: the set is trapped in one appserver, invisible to a second Roomy client or a fork | Private, but no portability; re-blocking required per client |
| Encrypted PDS record | "Works" only if every client has the key | No atproto precedent; key management is a larger project than blocks |

The chosen option is the same privacy posture as Bluesky, whose own lexicon
description says so outright: *"NOTE: blocks are public in Bluesky; see blog
posts for details."* A Roomy block is therefore no more revealing than the
Bluesky block it bootstraps from. What must **not** leak is the blocked
account's *content* to the blocker — which is a read-path problem (§3), not a
record-visibility one.

### 1.3 Publishing the schema

For another app to resolve `space.roomy.user.block`, the lexicon must be
published on the network as a `com.atproto.lexicon.schema` record with the rkey
set to the NSID, in the repo of the NSID authority. The authority for
`space.roomy.user.block` is `space.roomy` → domain `roomy.space`, and that
authority is already wired: `dig +short TXT _lexicon.roomy.space` returns
`"did=did:plc:cyqufxsezk33hqulcilckna6"` (measured 2026-09-26). No DNS work is
needed; publishing is one `putRecord` to that DID's repo, done out-of-band like
the HappyView lexicon uploads.

### 1.4 SDK and docs touch points

The block record is a **record only** — no query, no procedure, so the SDK's
codegen (`packages/sdk/scripts/generate-lexicons.ts`, which walks
`src/schemas/{queries,procedures}/*.ts`) does not generate anything for it.
`space.roomy.user.profile` is in the same position: it exists only as
`packages/appserver/lexicons/space/roomy/user/profile.json`, and there is no
`packages/sdk/src/schemas/lexicons/space.roomy.user.profile.json`. The block
record follows `profile.json`, not the query lexicons.

The XRPC endpoints this feature *does* add (`refreshBlocks`, §2.4) go through
the full convention: an arktype schema under `packages/sdk/src/schemas/`,
a `QUERY_SCHEMAS`/`PROCEDURE_SCHEMAS` entry in
`packages/sdk/src/transport/registry.ts`, a generated lexicon under
`packages/sdk/src/schemas/lexicons/`, a route in `buildRouter`
(`packages/appserver/src/appserver.ts:188`), prose in
`packages/docs/src/lib/endpoints/prose.ts` plus a regenerated
`nsids.generated.json`, and an entry in app-lite's `APPSERVER_RPCS`
(`packages/app-lite/src/lib/config.ts:3-52`). CI fails without the docs pair
(`packages/docs/scripts/check-registry.ts`).

### 1.5 OAuth scope

Blocking in-app writes to the user's own repo, so it needs a repo scope, placed
beside the existing entry at `packages/app-lite/src/lib/config.ts:144`:

```ts
`repo:space.roomy.user.profile`,
`repo:space.roomy.user.block`,   // NEW
```

and the matching `SCOPE+=" repo:space.roomy.user.block"` line near
`packages/app-lite/scripts/build-prod.sh:57`. The build-time drift check
(`build-prod.sh:165-220`) parses `config.ts` and fails the build if a quoted
`repo:`/`rpc:` entry is absent from the assembled scope, so the two edits must
land together.

**Consequence for existing sessions:** a repo scope the session lacks produces
an insufficient-scope error on the first block attempt. The reactive-consent
machinery for exactly this is designed but **not implemented** —
`packages/app-lite/docs/plans/progressive-scope-extension.md` is a plan only.
Phase 1 must therefore handle the error explicitly (§Phasing, Phase 1 step 5)
rather than assume a consent dialogue exists.

---

## 2. Bluesky bootstrap

### 2.1 Decision: reject HappyView; read the viewer's own PDS

**HappyView is rejected.** The task asked for the mechanism to be justified
rather than assumed, so here is the measurement that decides it.

`app.bsky.graph.block` is a *globally enormous* collection:

- **Repos holding block records.** `com.atproto.sync.listReposByCollection`
  on `relay1.us-west.bsky.network` returns 1000 repos per page. Paging 300
  consecutive cursors returned **300,000 repos without exhausting the cursor**
  (measured 2026-09-26; the relay's cursor is a keyset, so pages are disjoint
  by construction). The true count is at least 300k and was not reached.
- **Records per repo.** A 40-repo sample drawn across those pages returned
  2,948 records — **mean 73 block records per repo**, with the largest repo in
  the sample at 262.
- **Extrapolated index size:** on the order of **20 million records**.

Indexing that in HappyView means: a backfill whose discovery phase walks
≥300 relay pages, then resolve-and-fetch every one of those repos against their
PDS at up to 10 concurrent PDS hosts × 3 DIDs per host
(`https://happyview.dev/guides/backfill`) — hours of work and a multi-million-row
local index, permanently, to answer a question that is always **"what are the
N blocks in *this one viewer's own repo*"**, where N has mean 73.

The PDS is already the authoritative, pre-built index for exactly that query.
`com.atproto.repo.listRecords` for a public collection answers unauthenticated:
measured **HTTP 200 on five PDS hosts** (`bsky.social`,
`puffball.us-east.host.bsky.network`, `enoki.us-east.host.bsky.network`,
`morel.us-east.host.bsky.network`,
`earthstar.us-east.host.bsky.network`), paging 100 records at a time with a
cursor. A typical user (mean 73 records) therefore costs **one or two HTTP
calls** — one per collection — with:

- **Exact freshness.** HappyView is Jetstream-fed and eventually consistent —
  the tree already documents this and already routes around it: the profile
  handler consults the PDS *first* for read-after-write consistency
  (`handlers/space.roomy.user.getProfile.ts:88-105`;
  `e2e/profileEndpoints.test.ts:151-196` proves the PDS-over-HappyView
  precedence). For a safety feature, a window in which the user has blocked
  someone and can still read their next message is a correctness failure, not a
  latency cost — and the width of that window is not something this plan can
  bound, because it depends on HappyView's ingest lag, not on the appserver.
- **Cost proportional to the one user's own list**, not to a 20M-row global
  index.
- **No backfill job, no index-retention policy, no Jetstream collection filter
  to maintain.**

Jetstream was measured as a non-argument too: subscribing with
`wantedCollections=app.bsky.graph.block` yielded ~2.6 events/s (172 creates in
90 s), which is survivable in itself — the size of the *initial* index is what
kills it.

**What HappyView is still right for:** network-wide lookups keyed by *someone
else's* DID, like profiles (`space.roomy.user.getProfiles`, one HTTP call per
25 DIDs). Blocks are never that — the appserver only ever asks about the
caller's own repo. HappyView stays exactly as it is.

The appendix records the Lua script and the `target_collection` registration
that this decision would require, so that the choice is reversible on evidence
rather than on preference.

### 2.2 The fetch

New module `packages/appserver/src/materialization/blocks.ts`, modelled line
for line on `roomyProfile.ts` (which is the in-tree "read a user's own repo
over the network with a deadline" implementation):

```ts
// Shape only; the plan commits to the mechanism, not this spelling.
export async function fetchBlockRecords(did: string): Promise<BlockRecord[]> {
  const pds = await resolvePdsEndpoint(did);          // identity.ts:32, 5-min cache
  const agent = new AtpAgent({ service: pds });
  const out: BlockRecord[] = [];
  for (const collection of ["space.roomy.user.block", "app.bsky.graph.block"]) {
    let cursor: string | undefined;
    do {
      const resp = await agent.com.atproto.repo.listRecords(
        { repo: did, collection, limit: 100, cursor },
        { signal: AbortSignal.timeout(profileFetchTimeoutMs()) },  // fetchTimeout.ts:27-30
      );
      for (const r of resp.data.records) out.push(toBlockRecord(collection, r.value));
      cursor = resp.data.cursor;
    } while (cursor);
  }
  return out;
}
```

Properties, each mirroring an existing precedent:

- **One deadline per request.** `AbortSignal.timeout(profileFetchTimeoutMs())`
  — the same 3000 ms default (`packages/appserver/src/fetchTimeout.ts:38-47`)
  that bounds the profile PDS call (`roomyProfile.ts:99-105`). Unbounded PDS
  calls are the failure the profile pipeline was explicitly fixed for
  (`materialization/profileFetchBounds.test.ts`).
- **Two collections, one page loop.** The Roomy collection and the Bluesky
  collection are the same shape, so the same loop reads both and unifies them
  into one set.
- **`RecordNotFound` / 400 on an unknown collection is not an error.** A PDS
  that does not serve `space.roomy.user.block` at all (because the user has
  never blocked anything) is the common case; it yields an empty set, not a
  throw.
- **`resolvePdsEndpoint` is already cached** with a 5-minute TTL and
  stale-while-revalidate (`packages/appserver/src/identity.ts:32`), so the only
  per-refresh network cost is the `listRecords` page loop.

### 2.3 Where the set is stored

The read-state DB is the established home for appserver-owned, per-user,
non-reconstructible state (`packages/appserver/src/db/readStateSchema.sql:1-6`),
and it already holds every other `(user_did, …)` table. Add two tables and bump
the manifest:

```sql
-- ── User blocks (schema v11) ────────────────────────────────────────────
-- The resolved block set for a user: the union of the blocks in their own
-- repo (space.roomy.user.block) and their Bluesky blocks
-- (app.bsky.graph.block). A cache of the user's repos, not a source of
-- truth — a row deleted in another client disappears on the next refresh.
create table if not exists user_blocks (
  user_did    text not null,
  blocked_did text not null,
  source      text not null check(source in ('roomy', 'bluesky')),
  created_at  integer,
  fetched_at  integer not null default (unixepoch() * 1000),
  primary key (user_did, blocked_did)
) strict;

-- Last refresh attempt per user. Distinct from the rows above because a
-- user with zero blocks has no rows to carry a timestamp — the same
-- distinction profiles.ts draws between a profile row and its negative
-- cache (isProfileFetchBackedOff / recordUnresolvedProfiles).
create table if not exists user_block_fetches (
  user_did   text primary key,
  fetched_at integer not null,
  status     text not null check(status in ('ok', 'error'))
) strict;
```

`readStateVersions.ts` gains `"11": { kind: "structural" }` after the existing
`"10"` (`packages/appserver/src/db/readStateVersions.ts:53`, `:112`). No `up`
function is needed — the schema file is exec'd idempotently on every open, so
`create table if not exists` is already present on both fresh and existing DBs
(the manifest's own documented rule, `readStateVersions.ts:1-25`).

**Why a cached copy and not a per-request PDS call:** every read path in §3
needs the set, including the WebSocket delivery path and the push evaluator.
Three HTTP round-trips inside `#deliverRoomFrame` per frame is not viable, and
`getMessages` is already the slowest read endpoint in the system. The cache
gives all consumers one synchronous, indexed lookup.

**Refresh policy:**

- In-memory memo with a 60 s TTL, keyed by DID, mirroring the profile store's
  `CACHE_TTL_MS = 60_000` (`packages/appserver/src/queries/profileStore.ts:63`)
  and the negative cache in `profiles.ts:87-132`.
- Backed by one indexed read of `user_blocks` (`primary key (user_did,
  blocked_did)` gives a prefix scan on `user_did`).
- Background refresh on miss/stale, so a read never blocks on the PDS — the
  same detach-and-hydrate shape as `hydrateMissingProfiles`
  (`profileStore.ts:310-347`).
- A failed fetch records `status = 'error'` and backs off for 60 s rather than
  retrying per request (the `isProfileFetchBackedOff` pattern).
- **Anonymous callers have no block set.** `parseUserDid(auth) === null` → empty
  set, no DB read, no redaction. An account-less viewer has blocked nobody.

### 2.4 Immediate invalidation after an in-app block

A 60 s TTL alone would mean: user taps Block, the *server* keeps sending that
author's content for up to 60 s, and the user's own timeline keeps rendering it.
The client can hide it locally at once, but the server-side guarantee would lag.

So Phase 2 adds one authenticated procedure:

- **`space.roomy.user.refreshBlocks`** (procedure, authenticated, no body —
  the DID is the auth context). Drops the in-memory memo for `auth.did` and
  re-runs `fetchBlockRecords`, upserting `user_blocks` and stamping
  `user_block_fetches`. Fire-and-forget from the client's point of view: the
  write to the PDS has already succeeded, and a failure here self-heals at the
  next TTL expiry. Handler shape follows
  `handlers/space.roomy.room.updateSeen.ts` (validate → 401 → work →
  per-user invalidation signals).

The client calls it immediately after `putRecord`/`deleteRecord` succeeds. The
TTL remains the convergence path for a block written by *another* client.

---

## 3. Appserver side — where enforcement happens

### 3.1 Enforcement is read-time redaction, not materialisation-time, and not row removal

Two independent decisions, both forced:

**(a) Read-time, not materialisation-time.** The materialiser is
viewer-independent by construction: it writes one shared row per message for
every member of the space (`materialization/applyBatch.ts`,
`materialization/applyBundle.ts`). A block is per-viewer, so
materialisation-time enforcement would mean one stored copy per (message,
viewer) — a fan-out proportional to readership. Worse, a block written to a
PDS by another client produces **no event at all** in the appserver, so there
is nothing for the materialiser to react to. Read-time is the only place the
viewer's identity exists.

**(b) Redaction, not row removal — and this is what avoids the short-page
bug.** This is the point the task asks to be named explicitly.

`selectMessages` derives its cursor from the *page being full*:

```ts
// queries/selectMessages.ts:566-574
if (baseRows.length === limit) {
  nextCursor = messages[0]?.id ?? null;
}
```

A filter that removes blocked rows **after** the `LIMIT` therefore breaks in
two compounding ways:

1. **Short pages.** A page of 50 with 12 blocked-author rows returns 38.
2. **Pagination termination.** `baseRows.length` is still 50 (the filter ran
   after the limit), so `nextCursor` is set from a page that now holds 38
   messages — the boundary and the cursor disagree. In the degenerate case
   where a whole page is blocked authors, the client renders nothing and
   `ChatArea.loadOlderMessages` (`ChatArea.svelte:152-158`) sees
   `olderMessages.length === 0` and sets `hasMore = false`: **a blocked user's
   messages silently truncate the entire scrollback below them.**

(A pre-existing related hazard, worth naming so the fix is not blamed for it:
the room query orders by `e.sort_idx desc` but keysets on `e.id < ?2`
(`selectMessages.ts:194` vs `:206`). `sort_idx` is the ULID of the message's
*canonical* timestamp, which differs from the entity-id time for bridged
messages carrying `timestampOverride`. That mismatch can skip or duplicate rows
at a page boundary today. Redaction does not touch it — that is the point of
choosing redaction — but a row-removing filter would have made it worse and
blamed it on blocks.)

**The chosen shape: a tombstone row.** A blocked author's message is returned
as a `MessageDto` that keeps only the fields the indicator needs and carries no
content:

```ts
{
  id, sort_idx, timestamp,          // ordering and deep links unchanged
  authorDid,                        // the blocked identity, public by definition
  blocked: true,                    // NEW field on the Message schema
  content: "",
  authorName: "",
  reactions: [], media: [], linkEmbeds: [],
  // replyTo / forwardedFrom / lastEdit / mimeType / system: omitted
}
```

The row still occupies its position in the ordered page, so:

- `baseRows.length === limit` is unchanged → `nextCursor` is correct.
- Pages are full → the scrollback is contiguous.
- The deep link `?message=<id>` and row highlighting still resolve.
- The client has a place to draw the indicator, which is a hard requirement.

The alternative — omit the row entirely — cannot draw a per-message indicator
at all, and is the design that produces the truncation described above. The
task's UI requirement and the pagination requirement point at the same answer.

### 3.2 The SQL

Add a blocked-author flag to the base query rather than filtering rows. The
`json_each` shape was verified against the runtime's SQLite (bun:sqlite,
SQLite 3.53.0) — a JSON array bound as a parameter and expanded inside the
predicate returns the right rows — and JSON1 is already in use in the tree
(`coalesce(json_extract(payload,'$.canonical_parent'),0) = 1`,
`handlers/space.roomy.search.messages.ts:133-140`):

```sql
-- added to the select list of both room-scope and ids-scope
(case when author_e.tail in (select value from json_each(?N))
      then 1 else 0 end) as blocked
```

with `?N` = `JSON.stringify([...blockedDids])`, or `'[]'` when the viewer has
none. Bound as one parameter, not one-per-DID, so the statement text is stable
and the planner still uses `idx_entities_room_sort` — the same reason the
existing `order by e.sort_idx desc` comment gives for not wrapping the column
(`selectMessages.ts:188-193`).

In the assembly step (`selectMessages.ts:350-522`), a row with `blocked = 1`
short-circuits to the tombstone before content decoding, before the reaction /
media / link-embed maps are consulted, and before
`hydrateProfiles` (`:539-548`) would attach a name and avatar.

Two further guards, because the batch queries are keyed on the page's ids and
would otherwise pull a blocked message's content into the response:

- **Reactions, embeds and link-embed data** (`:285-290`, `:292-333`,
  `:415-420`) must exclude blocked message ids from the id list they are given,
  so a blocked message's media URLs, alt text and enriched link cards never
  enter the process.
- **Forward originals** (`:250-280`) recurse through `selectMessages` with
  `{ kind: "ids" }`, so the recursion must carry the block set and redact the
  embedded original when the *original's* author is blocked — a blocked
  author's words must not survive by being forwarded by somebody else. The
  forwarder's own row is redacted when the *forwarder* is blocked.

### 3.3 The other read surfaces

Each row of the §"Every route" table, with its fix:

| Surface | Fix |
|---|---|
| `message.getMessage` | Same tombstone — `selectMessages` `{ kind: "ids" }` carries the block set, so the route returns the tombstone and never the content |
| `search.messages` hits | Redact in the hydration loop (`:241`) from the hydrated `authorDid`. **Not** a Qdrant-side filter: `authorDid` is written as `""` on the backfill path (`search/backfill.ts:298`, vs the real value at `search/indexer.ts:294`) and has no payload index (`qdrantSearch.ts:177-182`), so a Qdrant `must_not` would miss every backfilled message |
| `search.messages` reply context | Redact the `reply.message` attachment (`:345`) |
| `getActivityFeed` | Redact inlined `recent_message_ids` bodies (`queries/activityFeed.ts:320-360`) and drop blocked DIDs from `latestMembers` |
| `room.getThreads` / `space.getThreads` / `room.getMetadata.recentThreads` | These read the `room_activity` projection and `threadActivity`'s `latestMessage` (`queries/threadActivity.ts:424-447`). The projection is reader-independent (`room_activity`, `schema-space.sql:391-398`), so redaction is applied **at read time** in `fetchRoomActivity` and in the `latestMembers` assembly — never in the projection, which has no viewer |
| `mention.getMentions` | Redact the `loadMentionMessages` DTOs (`queries/mentions.ts:294-300`) |
| `room.getLinks` / `space.getLinks` | A link row names the message that shared it. Redact (or drop) rows whose sharing message is authored by a blocked DID, so a blocked user's shared URLs do not surface in the links tab |
| `getReactions` | Drop blocked DIDs from the reactor list before profile resolution, so their name and avatar do not appear in the tooltip. (Their emoji *count* is a judgement call — see Open Question 5) |

### 3.4 Live path, counters, push

**`#messageDiff`** carries a complete `MessageDto`
(`invalidation/types.ts:77-97`, `sync/handler.ts:494-518`). The frame is built
**once per room topic** and delivered to every subscriber through
`#deliverRoomFrame` (`sync/handler.ts:526-537`), which already loops
per-connection for its access re-check. The redaction hooks into that same
loop:

```
for (const connId of connIds) {
  ...
  if (!(await this.#canReceiveRoomContent(roomId, conn.did))) continue;
  conn.send(this.#redactForViewer(frame, conn.did, authorDid));
}
```

`#redactForViewer` returns the *same object* when the connection has not
blocked the author — the overwhelmingly common case — so the change costs one
set membership test per connection and allocates only for the connections that
actually block. The block set for a connection is memoised with the same 60 s
TTL discipline as `#roomAccessCache` (`sync/handler.ts:434-475`).

**`#roomActivityDiff`** (`:554-579`) carries the author object and a preview
text (`invalidation/roomActivity.ts:118-143`); redact both per connection.
**`#roomMetadataDiff`** (`:610-645`) already iterates per user, so its unread
delta is simply not sent to a user who blocked the author.
**`#mention`** (`:581-608`) carries a snapshot; redact.
**`#streamEvents`** (`:963-990`) carries *raw event payloads* — the message body
bytes — and has no per-viewer filter at all. Today it is service-only: app-lite
subscribes only `room:` and `space:` topics (`useTopicSubscription` at exactly
two call sites, `routes/[space]/+layout.svelte:95` and
`routes/[space]/[room]/+page.svelte:126`), and the raw-event consumer is the
Discord bridge through the admin-gated `space.roomy.sync.getEvents`. See Open
Question 6.

**Unread counters.** `applyBundle` bumps `read_positions.unread_count` for
every user tracking the room (`materialization/applyBundle.ts:184-204`) — the
materialiser is viewer-independent, but the *statement* is not required to be,
because `read_positions.user_did` is already in scope. One correlated
subquery makes the bump block-aware without the materialiser knowing what a
block is:

```sql
update read_positions
   set unread_count = unread_count + 1, updated_at = (unixepoch() * 1000)
 where room_id = ?1
   and ?2 not in (select blocked_did from user_blocks
                   where user_did = read_positions.user_did)
```

with `?2` the effective author DID (the `authorOverride` value for bridged
messages — `applyBundle.ts:223-229` already resolves it for the participation
write). Both tables live in the same read-state DB, so this is a plain
subquery, no `ATTACH`. The thread variant (`:184-196`, an `insert … select
from user_thread_activity`) takes the same predicate on `uta.user_did`.

The same author-exclusion applies to `getRoomReadPositionUsers`
(`queries/readPositions.ts:514-524`), the recipient list behind
`#roomMetadataDiff` — otherwise the DB count and the pushed delta disagree.
And to `updateSeen`'s recomputed count
(`handlers/space.roomy.room.updateSeen.ts:89`,
`select count(*) from entities where room = ? and sort_idx > ?`), which is
already viewer-scoped and gains one `and author not blocked by userDid`
clause.

**Push.** Push evaluation already loops recipients individually
(`push/evaluate.ts` — "for each recipient (excluding the author)"), so a
blocked author skips the recipient before any payload is built. This matters
because the payload renders the author's name as the notification title
(`packages/app-lite/src/lib/notificationText.ts:32-50`): without the filter, a
push is a full reveal of both identity and (via the digest text) content.

**System messages are never redacted.** A system message's author is the
space itself (`selectMessages.ts:485-488`: `system` is
`author_did === stream_id`). Blocking a member must not erase "X joined the
space" notices, and the space DID is not a blockable identity.

---

## 4. app-lite side

### 4.1 The schema field

`blocked?: boolean` is added to the shared `Message` arktype schema
(`packages/sdk/src/schemas/queries/_message.ts:92-137`), which is used by
`room.getMessages`, `message.getMessage`, and the `#messageDiff` frame
(`packages/sdk/src/schemas/frames/messageDiff.ts:15-25`). One addition covers
all three, and `pnpm --filter @roomy-space/sdk generate:lexicons` regenerates
`packages/sdk/src/schemas/lexicons/*.json` under the CI `check:lexicons` gate.

The tombstone satisfies the schema as written: `content: ""`, `authorName: ""`,
and empty reaction/media/link arrays are all valid; `blocked` is the only new
field, and it is what distinguishes "blocked" from "a genuinely empty message".

### 4.2 Hiding the row

**The render seam already exists.** `MessageBubble` swaps the avatar for a
spinner when a send is pending — same slot, same size, nothing moves
(`packages/design/src/components/content/thread/message/MessageBubble.svelte:167-192`).
A blocked row is the same swap with a different glyph:

```svelte
{#if !isSystem}
  {#if blocked}
    <!-- A blocked author's row: the avatar position carries the indicator so
         the timeline's alignment is unchanged, and the row renders no
         content, no toolbar, no reactions. -->
    <div class="flex size-8 shrink-0 items-center justify-center sm:size-10">
      <IconBlocked class="size-4 shrink-0 text-base-400 dark:text-base-500" aria-label="Blocked user" />
    </div>
  {:else if deliveryState === "pending"}
    ...
```

Icon: `IconBlocked = ~icons/ph/x-circle-bold`, added to
`packages/design/src/icons/index.ts` (a one-line addition; `prohibit-bold` and
`x-circle-bold` both exist in the installed `@iconify-json/ph@1.2.2`, and
`x-circle-bold` is the literal "blocked-circle-X" Meri described).

`ChatMessage.svelte` computes the prop from the message it actually renders —
`message.blocked`, or `original.blocked` for a forward
(`ChatMessage.svelte:241`, `:259-263`) — and passes it to `MessageBubble`
alongside the existing props (`:383-399`). Everything else on the row is
suppressed: no toolbar, no reactions, no edit/delete/forward/select actions, no
hover affordances, no profile link, no `onAvatarClick`.

**The row is kept, not filtered, in `ChatArea`.** `mergeTimeline`
(`components/chat/timeline.ts`) preserves input order and count, and the
`Virtualizer` keys rows by id (`ChatArea.svelte:482-512`). Filtering
`timeline` would change the data length under the virtualizer's scroll math,
the `prevMessageCount` autoscroll (`:372-381`) and the `?message=` deep-link
index lookup (`:338-354`). Rendering through the tombstone keeps all three
untouched — the same reason the server redacts rather than removes.

### 4.3 Surfaces outside `MessageBubble`

Two components render message rows without reusing `MessageBubble` and need the
same treatment in Phase 4:

- **`components/search/SearchResultsList.svelte`** — renders `MessageBubble`
  compact (`:330`) but carries its own duplicated reply-preview markup
  (`:368-412`) and its own `m.reply?.message` / `m.forwardedFrom.message`
  rendering. All three paths need the blocked branch.
- **`components/feed/ActivityFeed.svelte`** — hand-rolled rows with their own
  avatar (`:181-195`) and content (`:231`), not `MessageBubble` at all.

### 4.4 The no-reveal constraint, client-side

The server redaction is the guarantee. The client adds a second layer because
`staleTime: Infinity` means the TanStack cache holds rows fetched *before* the
block:

- `lib/client.ts:19-28` — the WebSocket is the sole freshness authority; the
  cached array is only rewritten by `#messageDiff` or a manual refetch.
- `packages/sdk/src/sync/diff.ts:18-38` — an `add` op **replaces** the row
  wholesale, so a flag stored on a cached row does not survive reconciliation.
  (This is exactly why `mutations/pending-sends.svelte.ts` keeps delivery state
  in a side registry.)

So a client-side block set lives in its own module — the established app-lite
pattern of module-level `$state` in a `.svelte.ts` file, e.g.
`lib/components/layout/settings-bar.svelte.ts` — and `ChatArea` derives
`timeline` through a redaction pass over the cached array rather than mutating
it. The set is seeded from the same records the user just wrote (so blocking is
instant on the blocking device) and refreshed by
`space.roomy.user.getBlocks` on login.

The client layer is explicitly **belt, not guarantee**: it exists to close the
window between a local block and the server's refreshed set, and to survive a
stale cache. It is not the enforcement point and must not be described as one.

---

## 5. Interaction with the Discord bridge

**The intended behaviour, stated as three facts.**

1. **A bridged message is authored by a synthetic per-user DID.**
   `did:discord:<snowflake>` is written as the `authorOverride.v0` extension
   (`packages/discord-bridge/src/services/message-ingestion.ts:268-307`), and
   the SDK materialiser writes that override — not the bridge's own service
   DID — onto the message's `author` edge
   (`packages/sdk/src/schema/events/message.ts:54-74`). So the read path's
   `author_e.tail` for a bridged message *is* a stable, blockable identity,
   distinct from the bridge account.

2. **Therefore blocking a Discord user in Roomy works, per identity.**
   Blocking their `did:discord:<snowflake>` redacts their bridged messages
   through every surface in §3–§4 with no bridge involvement. The candidate DID
   for the block UI has to come from message authors, not from
   `space.roomy.space.getMembers`: bridged DIDs never hold member or admin
   edges, so they are absent from the roster
   (`queries/members.ts:77-100`) and appear only as message authors.

3. **Nothing changes on the bridge's write path, and the bridge cannot be
   asked to change.** A block is per-viewer; the bridge writes one record for
   the whole space. Suppressing a blocked author at ingest would hide them from
   everyone, which is not what a user-level block means. The bridge therefore
   keeps posting; the redaction is entirely on the Roomy read side.

**What does *not* work, and should be said plainly:** a Bluesky block does not
transfer to a Discord identity, or vice versa. There is no Discord↔ATProto
identity link in the tree — `packages/discord-bridge/src/db/schema.ts:25-33`
declares an `id_mappings.kind` union including `"user"`, but every production
`registerMapping` call site uses only `message`/`channel`/`thread`/`reaction`;
the `"user"` kind appears only in `repository.test.ts`. A user must block a
Discord participant by their `did:discord:` identity, and the block UI must
label it as such — which is the same `isBridged` distinction the client already
draws for profile links (`ChatMessage.svelte:228`, `MessageBubble.svelte:233-252`).

One service-path caveat: the bridge's own reads go through the admin-gated
`space.roomy.sync.getEvents`, which returns raw events and is not per-viewer.
That path is correct as-is (the bridge is not a viewer), but it means raw event
content remains readable by any service DID holding admin access — see Open
Question 6.

---

## 6. Phasing

Format and dispatch model follow
`packages/app-lite/docs/plans/progressive-scope-extension.md` (§Rollout
Phases). Each phase is one task, dispatched to one worker as soon as the
previous phase is merged or green, on a stacked branch.

```
next
 └── feat/user-blocks-p1        (record + write path, flag off)
      └── feat/user-blocks-p2   (appserver block set)
           ├── feat/user-blocks-p3   (timeline + getMessage + indicator)
           │    ├── feat/user-blocks-p4  (other read surfaces)
           │    ├── feat/user-blocks-p5  (live path, counters, push)
           │    └── feat/user-blocks-p6  (block management UX, flag on)
```

Every branch rebases onto its parent head before its PR is opened, and each
phase's PR states its base branch explicitly. Phase 4, 5 and 6 are independent
of one another and may run as three workers off Phase 3.

A new server-side feature flag `user-blocks` is registered in
`packages/appserver/src/featureFlags.ts:21-47` (alongside `search`,
`space-account-management`, `pro-subscription`, `links-view`,
`semble-integration`) and stays **false** until Phase 6. Phases 1–3 ship code
that is inert while the flag is off, so the Block affordance is never visible
without the enforcement behind it.

---

### Phase 1 — Roomy block record and the write path

**Base:** `next`. **Depends on:** nothing.

1. Add `packages/appserver/lexicons/space/roomy/user/block.json` (§1.1).
2. Publish the lexicon on the network as a `com.atproto.lexicon.schema` record
   in the repo of `did:plc:cyqufxsezk33hqulcilckna6` (the `_lexicon.roomy.space`
   authority) — out-of-band, documented in the package README.
3. Add `repo:space.roomy.user.block` to `packages/app-lite/src/lib/config.ts`
   (beside `:144`) **and** the matching `SCOPE+=` line in
   `packages/app-lite/scripts/build-prod.sh` (beside `:57`). Run the build to
   prove the drift check passes.
4. Add `lib/mutations/blocks.ts` in app-lite: `blockUser(did)` /
   `unblockUser(rkey)` writing to the user's own repo via
   `agent.com.atproto.repo.putRecord`/`deleteRecord` with the
   `atproto-proxy` header, exactly as the profile edit does
   (`routes/user/[user]/+page.svelte:126-190`).
5. Handle the insufficient-scope error explicitly: if the session predates the
   new `repo:` scope, the write fails with an authorization error — surface a
   clear message and offer a re-login. Do **not** silently retry.
   (The reactive consent dialogue is `progressive-scope-extension.md` Phase 5,
   which is not implemented; this phase must not depend on it.)
6. Add a `Block` action to the profile page, behind the `user-blocks` flag.
   The slot already exists and is currently populated only for the user's own
   profile: `packages/design/src/components/user/UserProfile.svelte:129-133`
   exposes `actions`, and `routes/user/[user]/+page.svelte:389-398` fills it
   with the edit button only, leaving the `{:else}` branch unpopulated.
7. Round-trip test: block, assert the record at
   `at://<did>/space.roomy.user.block/<tid>` via `listRecords`; unblock, assert
   its absence.

**Acceptance:** a public block record can be created and deleted, the OAuth
metadata contains the scope, and nothing is hidden yet.

---

### Phase 2 — The appserver block set

**Base:** `feat/user-blocks-p1`. **Depends on:** Phase 1 (the collection must
exist for the fetch to have anything to read).

1. `packages/appserver/src/materialization/blocks.ts` — `fetchBlockRecords`
   (§2.2), modelled on `roomyProfile.ts`.
2. `user_blocks` + `user_block_fetches` in
   `packages/appserver/src/db/readStateSchema.sql`; `"11": { kind: "structural" }`
   in `readStateVersions.ts` (§2.3).
3. `packages/appserver/src/queries/userBlocks.ts` — `getBlockedDids(userDid)`
   with the 60 s in-memory memo, the negative/error backoff, and a detached
   background refresh mirroring `queries/profileStore.ts` and
   `materialization/profiles.ts`.
4. `space.roomy.user.refreshBlocks` procedure (§2.4): SDK arktype schema,
   `PROCEDURE_SCHEMAS` entry, generated lexicon, route in `buildRouter`, prose
   in `packages/docs/.../prose.ts` + regenerated `nsids.generated.json`, and
   an `APPSERVER_RPCS` entry.
5. Wire the client: after a successful block/unblock write, fire
   `refreshBlocks` (fire-and-forget).
6. Unit tests: the union of the two collections; an empty repo; a PDS that
   404s the unknown collection; a fetch failure recorded as `status:'error'`
   with backoff; the TTL expiry triggering a refetch. The PDS call must be
   stubbed — `materialization/profileFetchBounds.test.ts` is the template for
   proving every call site is deadline-bounded.

**Acceptance:** `getBlockedDids` returns the correct union for a user with both
Roomy and Bluesky blocks, and no read path is affected yet.

---

### Phase 3 — Timeline redaction and the indicator

**Base:** `feat/user-blocks-p2`. **Depends on:** Phase 2. **This is the phase
that satisfies the core requirement.**

1. Add `blocked?: boolean` to `packages/sdk/src/schemas/queries/_message.ts`;
   regenerate lexicons.
2. `selectMessages`: carry the block set into both scopes; add the
   `case when … json_each` flag column to the base SQL (§3.2); build the
   tombstone in the assembly step; exclude blocked ids from the reaction /
   embed / link-data batches; thread the block set through the forward-original
   recursion.
3. `message.getMessage` picks the behaviour up through `{ kind: "ids" }`; add a
   test that the route returns a tombstone, not the row.
4. `packages/design/`: `MessageBubble` gains `blocked`, renders the indicator
   in the avatar slot and no body (`MessageBubble.svelte:167-192`);
   `icons/index.ts` gains `IconBlocked`.
5. `ChatMessage.svelte` computes and forwards `blocked` (including
   `original.blocked` for forwards) and suppresses the toolbar, reactions and
   actions on a blocked row.
6. Client-side redaction pass over the cached array in `ChatArea` (§4.4), plus
   the block-set module.
7. Tests: `selectMessages` returns a full-length page with tombstones in place
   and an unchanged `nextCursor`; the tombstone carries no content, media, link
   embeds, reactions or profile fields; a forward of a blocked author's message
   is redacted; `ChatArea.loadOlderMessages` still pages past a fully-blocked
   block of history.

**Acceptance:** with the flag on, a blocked author's messages appear as an
indicator-only row in the room timeline and in `getMessage`, and paging past
them is uninterrupted.

---

### Phase 4 — Every other read surface

**Base:** `feat/user-blocks-p3`. **Depends on:** Phase 3. Independent of
Phase 5.

1. `search.messages`: redact hits and `reply.message` (§3.3).
2. `getActivityFeed`: redact inlined message bodies and `latestMembers`.
3. `threadActivity` / `room_activity` read path: redact `latestMessage.content`
   and `latestMembers` at read time, never in the projection.
4. `mention.getMentions`: redact message snapshots.
5. `getLinks` (room + space): redact rows whose sharing message is blocked.
6. `getReactions`: drop blocked DIDs from the reactor list.
7. app-lite: the blocked branch in `SearchResultsList.svelte` (including its
   duplicated reply-preview markup) and `ActivityFeed.svelte`.
8. Tests, one per surface, each asserting that no blocked content, name or
   avatar appears in the response.

**Acceptance:** the §"Every route" checklist is covered end-to-end by a test
per row.

---

### Phase 5 — Live path, counters, push

**Base:** `feat/user-blocks-p3`. **Depends on:** Phase 3. Independent of
Phase 4.

1. `sync/handler.ts`: per-connection redaction in `#deliverRoomFrame` for
   `#messageDiff` and `#roomActivityDiff`; per-user skip in
   `#roomMetadataDiff`; redaction of `#mention`. Each guards a per-connection
   block-set lookup behind the 60 s memo, and returns the original object
   unchanged when the connection has blocked nobody (§3.4).
2. Unread counters: the correlated-subquery predicate on the `read_positions`
   bump in `applyBundle.ts`, on `getRoomReadPositionUsers`, and on
   `updateSeen`'s recomputed count (§3.4).
3. Push: skip a recipient who blocked the author, before any payload is built.
4. Tests: a frame delivered to two connections where one has blocked the
   author — one receives the full message, the other the tombstone; a blocked
   message does not increment `unread_count`; no push is produced to a blocker.
   `sync/handler.ts` and `StreamManager.test.ts` are the existing harnesses.

**Acceptance:** no live frame, unread count, or push reveals a blocked author's
content to a blocker.

---

### Phase 6 — Block management UX and flag on

**Base:** `feat/user-blocks-p3`. **Depends on:** Phase 3. Independent of
Phases 4 and 5, but must not ship before them.

1. A "Blocked users" page under `routes/user/settings/blocks/`, listing the
   resolved set with its source (Roomy / Bluesky) and an unblock action;
   the nav entry beside General/Notifications/Subscription
   (`routes/user/settings/+layout.svelte:90-125`) plus the `settingsPageName`
   `switch` (`:24-35`) and the sidebar entry in
   `routes/user/settings/+page.svelte`.
2. Unblocking a Bluesky-only block: the record lives in the user's Bluesky
   collection, so the UI must state that it can only be removed from Bluesky —
   or offer to delete the `app.bsky.graph.block` record too (Open Question 9).
3. Enable `user-blocks` by default.
4. E2E: seed a block (the seeder already inserts feature flags directly —
   `packages/app-lite/e2e/seed.ts:230-235`), open the room, assert the
   indicator renders in the avatar position and the body is absent.

**Acceptance:** the flag is on, blocked users are listed and manageable, and
the E2E suite covers the visible behaviour.

---

## 7. Open questions for Meri

**1. Record key: `tid` (one record per block) or `literal:self` (one list
record)?**
**Recommendation: `tid`.** It mirrors `app.bsky.graph.block` exactly, makes the
bootstrap a copy, avoids a read-modify-write race between two devices, and
preserves per-block `createdAt`. The cost is that unblocking needs the rkey,
which the client learns from the same `listRecords` read it already performs.

**2. Public repo record, or appserver-only storage?**
**Recommendation: public repo record.** atproto has no private records; the two
real alternates are an appserver-only table (private but trapped in one
appserver, no cross-app blocking, no portability) or an encrypted record (no
precedent, key management is a bigger project). Bluesky's own block record is
public and its lexicon says so. The consequence to accept explicitly: a Roomy
block list is world-readable and the blocked account can learn it is blocked.
If Meri wants the block list *itself* to be private in v1, the honest fallback
is the appserver-only table in the readstate DB — same read paths, same
enforcement, no record and no `repo:` scope — with the record added later when
portability matters more than privacy. This changes Phase 1, not Phases 2–6.

**3. A tombstone row, or omit the message entirely?**
**Recommendation: tombstone.** It is what makes Meri's avatar-position
indicator possible at all, and it is what keeps pagination correct: the row
keeps its slot, so `baseRows.length === limit` and the cursor derivation
(`selectMessages.ts:566-574`) are untouched. Omitting the row produces short
pages and, when a whole page is blocked authors, silently terminates the
scrollback (`ChatArea.loadOlderMessages` → `hasMore = false`). The tombstone
carries `id`, `sort_idx`, `timestamp`, `authorDid` and `blocked: true`;
everything else is empty or absent. If Meri prefers omission, the pagination
defect must be fixed first — by moving the filter into the SQL `where` and
re-deriving the cursor from a filtered-but-full page — which is a larger change
to the same statement.

**4. Does a block suppress the blocked user's push notifications and unread
counts?**
**Recommendation: yes, both.** Both are reveals: the push payload renders the
author's name as its title (`lib/notificationText.ts:32-50`), and an unread
badge that counts a message you cannot open is a visible inconsistency
("3 unread", room shows nothing). Both fixes are per-user and cheap (§3.4).

**5. Reaction tooltips: hide a blocked user's name from other people's
messages, or only from their own?**
**Recommendation: hide.** A block means "I do not want to see this account" —
a name and avatar appearing in a reaction tooltip on somebody else's message
defeats that. Keep the emoji count (it is not identity), drop the reactor's
name and avatar from the list. Cheap, and reversible.

**6. Raw `#streamEvents` frames carry the message body and have no per-viewer
filter. Restrict stream topics to service DIDs?**
**Recommendation: restrict.** Today only the Discord bridge subscribes to a
`stream:` topic, through the admin-gated `space.roomy.sync.getEvents`; app-lite
subscribes only `room:` and `space:` (`routes/[space]/+layout.svelte:95`,
`routes/[space]/[room]/+page.svelte:126`). Because the frame carries
unredacted event payloads, a user-facing connection subscribed to a raw stream
topic would bypass every block in this plan. Either forbid user DIDs from
`stream:` topics (the check exists — `#canReceiveStream`,
`sync/handler.ts:940`) or accept and document the exception. Recommended for
this project: forbid, and note it in the sync docs.

**7. Direction of hiding: one-way, or mutual?**
**Recommendation: one-way (the blocker stops seeing the blocked).** That is
what Meri asked for, and it is the minimum that satisfies it. The consequence
to accept: a block is not a shield — the blocked account keeps seeing the
blocker's messages. Mutual hiding is a different product decision (it makes a
block visible to its target) and would need both directions redacted; say the
word and it is a small addition to §3, not a new phase.

**8. Should blocking in Roomy also write an `app.bsky.graph.block` record?**
**Recommendation: no.** Blocking on Roomy is a Roomy act; silently changing a
user's Bluesky graph would surprise them, and it would need the Bluesky
collection in the OAuth scope. The Bluesky direction stays read-only. Revisit
if users ask for it — the mirrored record shape makes it a one-line addition.

**9. How should an imported Bluesky block be unblocked from Roomy?**
**Recommendation: delete the `app.bsky.graph.block` record** (the user owns
it; the client can write it), and label it as a Bluesky block in the list so
the action is not surprising. The alternative — read-only imported blocks that
must be removed in Bluesky — is more conservative but leaves a dead entry in
the list with no explanation of why it cannot be acted on.

**10. Does the block set need to cover bridged `did:discord:` authors in v1?**
**Recommendation: yes, structurally, with an honest label.** The mechanism
already covers them for free (the author edge *is* the `did:discord:` DID —
`packages/sdk/src/schema/events/message.ts:54-74`), and the block UI can source
those DIDs from message authors. There is no Discord↔ATProto identity link in
the tree, so a Bluesky block will not transfer, and the UI must say
"blocked on Roomy only" for these — which is the same distinction the client
already draws with its `isBridged` marker.

**11. Pre-existing pagination hazard: fix it in this project?**
**Recommendation: no, out of scope — but record it.** The room query orders by
`sort_idx` while keysetting on `e.id < ?2` (`selectMessages.ts:194` vs `:206`),
which can skip or duplicate rows at a page boundary for bridged messages
carrying `timestampOverride`. Redaction deliberately does not touch either
clause. It deserves its own task.

---

## Appendix — if HappyView is nonetheless required

Recorded so the §2.1 decision can be revisited on evidence. Indexing
`app.bsky.graph.block` in HappyView needs three out-of-band registrations
(nothing in this repository performs them — the `packages/appserver/lexicons/`
directory is documentation only and is never read at runtime):

1. `POST /admin/lexicons` with the `app.bsky.graph.block` record lexicon and
   `backfill: true` → adds the collection to the Jetstream filter, starts a
   backfill, returns a `backfill_job_id`. Or `POST /admin/network-lexicons`
   with `{ nsid: "app.bsky.graph.block" }` to resolve the published schema via
   DNS authority instead of hosting a copy.
2. `POST /admin/lexicons` with a query lexicon
   (`space.roomy.user.getBlocks`-shaped) and
   `target_collection: "app.bsky.graph.block"`.
3. `POST /admin/scripts` with `id: "xrpc.query:<nsid>"` and the Lua body —
   the same registration form the in-tree script documents for itself
   (`packages/appserver/lexicons/space/roomy/user/getProfiles.lua:7`).

The Lua is materially simpler than `getProfiles.lua`: one `db.query` with a
`did` filter, a `filter = { field = "subject", value = params.subject }` when a
reverse lookup is wanted, `limit`/`cursor` passthrough, and
`return { blocks = toarray(result.records), cursor = result.cursor }`. The
`db.query` API supports exactly that (`did`, `filter`, `cursor`, limit 100) —
see `https://happyview.dev/api-reference/lua/database-api`.

The costs that decided against it remain: ≥300k repos to discover, ~20M
records to index, a multi-hour backfill, a permanent index, and Jetstream-level
eventual consistency standing between a block and its enforcement.

---

## References

**In-tree — read paths**
- `packages/appserver/src/queries/selectMessages.ts` — room SQL `:153-196`,
  `where` `:185-186`, order/limit `:194-195`, ids scope `:206-243`, forward
  recursion `:250-280`, batch queries `:285-290` `:292-333` `:415-420`,
  assembly `:350-522`, hydration `:539-548`, cursor `:566-574`
- `packages/appserver/src/handlers/space.roomy.room.getMessages.ts`
- `packages/appserver/src/handlers/space.roomy.message.getMessage.ts:44`
- `packages/appserver/src/handlers/space.roomy.search.messages.ts` —
  `OVERFETCH :53`, hydration `:241`, post-filter `:306-316`, reply `:345`
- `packages/appserver/src/search/qdrantSearch.ts:80-88`, `:177-182`, `:293-318`
- `packages/appserver/src/search/indexer.ts:294`, `search/backfill.ts:298`
- `packages/appserver/src/queries/activityFeed.ts:156-165`, `:320-360`
- `packages/appserver/src/queries/threadActivity.ts:424-447`
- `packages/appserver/src/queries/roomActivityProjection.ts`
- `packages/appserver/src/queries/mentions.ts:294-300`
- `packages/appserver/src/handlers/space.roomy.message.getReactions.ts`
- `packages/appserver/src/queries/readPositions.ts:514-524`
- `packages/appserver/src/handlers/space.roomy.room.updateSeen.ts:23-117`

**In-tree — live path, counters, push**
- `packages/appserver/src/sync/handler.ts` — `#canReceiveRoomContent :434-475`,
  `#routeMessageDiff :494-518`, `#deliverRoomFrame :526-537`,
  `#roomActivityDiff :554-579`, `#mention :581-608`, `#roomMetadataDiff :610-645`,
  `#canReceiveStream :940`, `#streamEvents :963-990`
- `packages/appserver/src/invalidation/inferSignals.ts:295-308`, `:339`
- `packages/appserver/src/invalidation/roomActivity.ts:118-143`
- `packages/appserver/src/materialization/applyBundle.ts:184-204`, `:223-229`
- `packages/appserver/src/push/evaluate.ts`
- `packages/app-lite/src/lib/notificationText.ts:32-50`

**In-tree — storage and patterns**
- `packages/appserver/src/db/readStateSchema.sql` — `read_positions :57-77`,
  `pro_role_grants :209`
- `packages/appserver/src/db/readStateVersions.ts:53`, `:112`
- `packages/appserver/src/db/schema-space.sql` — `room_activity :391-398`,
  `comp_bans :295-301`, `edges :54-67`
- `packages/appserver/src/materialization/roomyProfile.ts:55`, `:88-100`,
  `:126-165`
- `packages/appserver/src/materialization/profiles.ts:87-132`, `:223-295`
- `packages/appserver/src/queries/profileStore.ts:63`, `:310-347`
- `packages/appserver/src/happyview.ts:37-93`
- `packages/appserver/src/fetchTimeout.ts:27-47`
- `packages/appserver/src/identity.ts:32`
- `packages/appserver/src/handlers/space.roomy.user.getProfile.ts:88-105`
- `packages/appserver/src/featureFlags.ts:21-47`
- `packages/appserver/src/appserver.ts:188`, `:198-201`, `:408-412`
- `packages/appserver/src/e2e/profileEndpoints.test.ts:151-196`
- `packages/appserver/src/materialization/profileFetchBounds.test.ts`

**In-tree — client**
- `packages/sdk/src/schemas/queries/_message.ts:92-137`
- `packages/sdk/src/schemas/frames/messageDiff.ts:15-25`
- `packages/sdk/src/sync/diff.ts:18-38`, `sync/router.ts:122-136`
- `packages/sdk/src/schema/events/message.ts:54-74`
- `packages/app-lite/src/lib/config.ts:3-52`, `:134-157`, `:144`
- `packages/app-lite/scripts/build-prod.sh:49-138`, `:165-220`
- `packages/app-lite/src/lib/client.ts:19-28`
- `packages/app-lite/src/lib/queries/messages.ts`
- `packages/app-lite/src/lib/components/chat/ChatArea.svelte` — `mergeTimeline
  :85-87`, `loadOlderMessages :152-158`, `Virtualizer :482-512`
- `packages/app-lite/src/lib/components/chat/ChatMessage.svelte:228`, `:241`,
  `:259-263`, `:383-399`
- `packages/app-lite/src/lib/components/chat/timeline.ts`
- `packages/app-lite/src/lib/components/chat/MessageContextReply.svelte`
- `packages/app-lite/src/lib/components/search/SearchResultsList.svelte:330`,
  `:368-412`
- `packages/app-lite/src/lib/components/feed/ActivityFeed.svelte:181-195`,
  `:231`
- `packages/app-lite/src/routes/[space]/+layout.svelte:95`
- `packages/app-lite/src/routes/[space]/[room]/+page.svelte:126`
- `packages/app-lite/src/routes/user/[user]/+page.svelte:126-190`, `:389-398`
- `packages/app-lite/src/routes/user/settings/+layout.svelte:24-35`, `:90-125`
- `packages/app-lite/e2e/seed.ts:230-235`
- `packages/design/src/components/content/thread/message/MessageBubble.svelte:167-192`
- `packages/design/src/components/user/UserAvatar.svelte`
- `packages/design/src/components/user/UserProfile.svelte:129-133`
- `packages/design/src/icons/index.ts`

**In-tree — bridge**
- `packages/discord-bridge/src/services/message-ingestion.ts:268-307`
- `packages/discord-bridge/src/db/schema.ts:25-33`
- `packages/appserver/src/queries/members.ts:77-100`

**In-tree — conventions this plan follows**
- `packages/app-lite/docs/plans/progressive-scope-extension.md` (phase format,
  stacked-PR dispatch model)
- `packages/app-lite/docs/plans/e2e-ui-coverage.md`

**Network — measured 2026-09-26**
- `app.bsky.graph.block` lexicon: `bluesky-social/atproto`,
  `lexicons/app/bsky/graph/block.json` — `key: "tid"`, `subject` (did),
  `createdAt`
- Relay repo enumeration: `com.atproto.sync.listReposByCollection` on
  `relay1.us-west.bsky.network`, 1000/page, ≥300,000 repos sampled across 300
  pages without exhaustion
- Records per repo: 40-repo sample → 2,948 records, mean 73, max 262
- Unauthenticated `com.atproto.repo.listRecords` for `app.bsky.graph.block`:
  HTTP 200 on `bsky.social`, `puffball`, `enoki`, `morel`, `earthstar`
  (`*.us-east.host.bsky.network`)
- Jetstream `wantedCollections=app.bsky.graph.block`:
  ~2.6 events/s (172 creates in 90 s)
- `_lexicon.roomy.space` TXT → `did=did:plc:cyqufxsezk33hqulcilckna6`
- SQLite (bun:sqlite, 3.53.0): `json_each` over a bound JSON array inside an
  `in (...)` predicate returns the expected rows

**External**
- Lexicon spec: https://atproto.com/specs/lexicon — record `key` is required;
  `type: "record"`, `key`, `record`
- Record key spec: https://atproto.com/specs/record-key — `tid`, `literal:`,
  `any`; allowed charset
- OAuth spec: https://atproto.com/specs/oauth — `scope` must be a subset of
  the client metadata ceiling; no private records
- HappyView backfill: https://happyview.dev/guides/backfill
- HappyView lexicons: https://happyview.dev/guides/lexicons
- HappyView Lua database API:
  https://happyview.dev/api-reference/lua/database-api
