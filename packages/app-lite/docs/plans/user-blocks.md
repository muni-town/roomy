# User-level blocks — Implementation Plan

**Date:** 2026-09-26 (revised 2026-09-27, 2026-09-28, 2026-10-13, 2026-10-15)
**Status:** Phase 1 shipped (#317, `9731537c5`); Phase 2 (the appserver block
set) merged to `next` (#427). Phases 3–6 are ready to dispatch; §7 is a
decision record and every question in it is answered. Phase 2's
`space.roomy.user.refreshBlocks` scope is deferred (`BLOCK_RPC_SCOPES`,
`UNREGISTERED_SCOPES`) until it is registered on the HappyView API client,
alongside `repo:space.roomy.user.block` — a `base`-tier entry breaks sign-in
for everyone (§1.4, §1.5).

**Revision 2026-10-13 (a) — the reveal is a transient read, not a state.** An
admin may *look at* a message from an account they personally blocked, in a
space they administer. The act changes nothing: it writes no row, is not
audited, and is not attributable to anyone. Server-side the reveal is
therefore a single route — `space.roomy.message.getMessage` returns the full
message to a caller who is an admin of the message's space and whose own block
set names the author. Every other message-returning route, and every pushed
frame, unread count and push payload, is redacted for that caller exactly as
it is for everyone else. The per-block `revealInSpaces` field (§1.1) and the
`block_reveals` audit table (§7.14) of the earlier revisions are **removed**:
the reveal is a view rather than an act, so there is nothing to record, and no
per-space grant for the record to carry. It **adds an exception** to §7.7's
mutual redaction; it does not reverse it. §3.6 and §7.12–§7.16 state the rule
in full.

**Revision 2026-10-13 (b) — the block RPC scope is deferred with the repo
scope.** Phase 2 added the RPC NSID to `APPSERVER_RPCS`, which put it in
`base`; the deployed HappyView client does not list it and rejected the whole
granted set at session registration, blocking sign-in. Both block scopes now
live in the ceiling-only `blocks` tier until the client lists them.

**Revision 2026-10-15 — the reverse index is built from each account's own
requests, and the member sweep is gone.** The reverse set was to be recovered by
enumerating the members of every space the viewer had joined and reading each
member's repos (§3.5). That sweep ran on the read path, so one viewer's reads
read the PDSs of every account they shared a space with: measured on the
deployed appserver over 24 h, ~300 distinct accounts were read, individual sets
reached 56k records, and the resulting `delete from user_blocks` writes
saturated the read-state worker. It is **removed**. A read never starts a fetch
now, and a refresh is triggered only by the account it describes — when that
account makes an authenticated request. §2.5 states the freshness that trades
away, why it is the safe direction, and why a Jetstream consumer is still not
the answer.

**Packages:** `packages/appserver`, `packages/app-lite`, `packages/design`,
`packages/sdk`, `packages/docs`

## Goal

A Roomy user can block another account. **A block hides in both directions**
(§7.7): the blocker stops seeing the blocked account, and the blocked account
stops seeing the blocker. On both sides a hidden author's messages are replaced
by a subtle indicator, and the content is not revealable through any route —
not the room timeline, not search, not the activity feed, not thread replies,
not a bridged copy, not a push notification, not a live WebSocket frame.

**One exception, and exactly one (§3.6):** a space admin may reveal a hidden
message in a space where they hold the admin edge, for a block they placed
themselves. That is the only principal, the only scope and the only relation
that opens a tombstone; everywhere else the sentence above is unchanged and
absolute. An admin who did not place the block sees nothing an ordinary member
does not (§3.6, §7.12).

Blocking is set in two places:

1. **Bootstrap from Bluesky** — an account's existing `app.bsky.graph.block`
   records are imported so a new Roomy user does not have to re-block everyone.
2. **A new Roomy block record** — written when a user blocks in-app, so a user
   with no Bluesky presence can block, and so the block is portable to any
   Roomy client rather than trapped in one appserver's database.

The stated UI: a small grey blocked-circle-X icon in the avatar position,
centred.

---

## Verified starting point

Everything below is verified against `origin/next` = `0f336883` and against live
network endpoints on 2026-09-26. Facts are named with their source file and
line; network facts name the measurement. Line references were re-checked
against this tree: `#292` shifted the parts of `selectMessages` and
`sync/handler.ts` it touched, and every reference below names the post-`#292`
location (§7.11).

**The 2026-09-28 revision was re-verified against `origin/next` = `122ce5f4`**
(16 commits after `0f336883`). Every file this plan's server-side design rests
on — `queries/selectMessages.ts`, `sync/handler.ts`,
`materialization/applyBundle.ts`, `auth/access.ts`, `xrpc/authGuards.ts`,
`queries/members.ts`, `handlers/…/getMessages.ts`, `handlers/…/getMessage.ts` —
is byte-identical across that range. Two client files cited below moved:
`MessageBubble`'s avatar slot is `:205-233` (was `:167-192`) and
`ChatMessage`'s `MessageBubble` props are `:384-400` (was `:384-399`); the
revision carries the new numbers and all three sections that cite the old ones
(§4.2, §4.3, §4.4) were updated. `space.roomy.sync.getEvents`,
`sync/handler.ts`'s stream path and the bridge's live gateway were read
directly for §7.15 and are as described there.

**There is no block/mute/hide concept anywhere in the tree.** No table (checked
all five schema files), no SDK event in `eventRegistry`
(`packages/sdk/src/schema/events/registry.ts:54-98`), no XRPC route, no
query param, no UI. `app.bsky.graph.*` and `com.atproto.repo.listRecords`
appear nowhere. The only moderation primitive is a **space-scoped ban**
(`comp_bans`, `packages/appserver/src/db/schema-space.sql:306-311`), which is
space-admin-owned and has nothing to do with a per-viewer block.

**No per-viewer filtering exists in any read.** `selectMessages` takes
`viewerDid` and uses it for exactly one thing — `myReactionId`
(`packages/appserver/src/queries/selectMessages.ts:399`, `:499`). Every read is
filtered by *room read access* only. Live frames are built once per room topic
and sent to every authorised connection (`#routeMessageDiff` and
`#deliverRoomFrame`, `packages/appserver/src/sync/handler.ts:508-555`).

### Message read path (what a block has to intercept)

| Piece | Location |
|---|---|
| Room-scope keyset SQL | `queries/selectMessages.ts:169-231` |
| Cursor key resolution | `:157-162` — a cursor id resolves to its own `coalesce(sort_idx, id)` before the keyset compare |
| `where` clause | `:219-220` — `e.room = ?1 and (cc.entity is not null or forward_e.tail is not null)` |
| Keyset + order + page size | `:221-226` — `coalesce(e.sort_idx, e.id)` desc, `id` desc, `limit min(limit,100)` |
| Next cursor | `:598-606` — `baseRows.length === limit` → `nextCursor = messages[0].id` |
| Forward-original recursion | `:281-311`, recursive call `:305-309` |
| Reactions / embeds / link data batches | `:313-379`, `:432-458` |
| Assembly | `:477-555` |
| Profile hydration | `:570-579` |
| Handler | `handlers/space.roomy.room.getMessages.ts:34-38` (limit 1–100, default 50) |

The filter clause keeps exactly the message-shaped entities and has no
author predicate, so a block is a new predicate over the same rows.

### Every route that can carry a blocked author's content

This list is the no-reveal checklist — every route that can carry a blocked
author's content, and therefore every route that has to be redacted. Each row
is a distinct leak surface, not a variation of one. Row 2 is the **only** row
that carries §3.6's admin reveal; every other row is redacted for every caller,
admins included (§3.4 tabulates the pushed and counted surfaces):

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
| 12 | Live message diff | `sync/handler.ts:508-531` | Full DTO |
| 13 | Live activity diff | `sync/handler.ts:572-600` | Author + preview text |
| 14 | Live unread diff | `sync/handler.ts:630-666` | A blocked message bumping unread |
| 15 | Live mention frame | `sync/handler.ts:602-628` | Full DTO |
| 16 | Raw stream events | `sync/handler.ts:988-1010` | Unredacted event body |
| 17 | Push payloads | `push/evaluate.ts` + app-lite `lib/notificationText.ts` | Author name + text |
| 18 | Unread counters | `materialization/applyBundle.ts:184-204` | Blocked msg counted as unread |
| 19 | Forwarded copies | `selectMessages.ts:542-550` `forwardedFrom.message` | Original DTO |
| 20 | Reply previews | `MessageContextReply.svelte`, `SearchResultsList.svelte:368-412` | Author + snippet |
| 21 | Client cache | `getMessages` TanStack cache, `staleTime: Infinity` | Previously-fetched row |

Surfaces 19–21 are the ones a server-only design forgets: a forward embeds a
*different* author's full DTO (`selectMessages.ts:281-311`), the search list
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
      "description": "A user's block of another account, written to the blocking user's own repo. A block hides both ways: it hides the blocked account's messages from the blocker, and the blocker's messages from the blocked account. The record is public: atproto repositories are world-readable, and app.bsky.graph.block — the source of the Bluesky bootstrap — is public for the same reason.",
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

The record is the *only* evidence of a block for the party it names: the
blocked account has no record of its own, so the reverse direction (§3.5) is
recovered by reading blockers' repos, which is only possible because this
record is public (§1.2).

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

**No field is Roomy-only,** so the conversion is a copy in both directions
rather than a translation in one: a Bluesky block imports as-is, and a Roomy
block exports as-is. Nothing on the record says *where* a block may be acted
on — the reveal is a property of who is looking, not of what was written
(§3.6).

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
set to the NSID, in the repo of the NSID authority. The authority is derived
from the NSID — drop the name segment, reverse the rest, look up
`_lexicon.<that domain>` — and resolution is not hierarchical, so a resolver
never falls back to a parent domain. For `space.roomy.user.block` that is
`_lexicon.user.roomy.space`, which resolves to
`did:plc:cyqufxsezk33hqulcilckna6` (the `roomy.space` account — the authority
`_lexicon.roomy.space` already names). The record itself is **not** in that
repo: `com.atproto.repo.getRecord` for
`at://did:plc:cyqufxsezk33hqulcilckna6/com.atproto.lexicon.schema/space.roomy.user.block`
returns `RecordNotFound` (checked 2026-10-13).

One step is therefore outstanding, out-of-band and outside every phase's
scope — `putRecord` the lexicon into the authority's repo:

```
bun run scripts/publish-lexicons.ts space.roomy.user.block
```

with `LEXICON_AUTHORITY_IDENTIFIER` / `LEXICON_AUTHORITY_PASSWORD` set
(`packages/appserver/README.md`). Nothing in the build, the deploy, the
appserver or the client reads the published record — the appserver writes the
collection name as a literal and never resolves the lexicon — so it exists for
third-party resolution only, and it blocks no phase.

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
`nsids.generated.json`, and a `BLOCK_RPC_SCOPES` entry in
`packages/app-lite/src/lib/scopes.ts` (ceiling-only until registered — §1.5).
CI fails without the docs pair
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
- Background refresh, started by the account's own authenticated request rather
  than by a read (§2.5), so a read never blocks on the PDS — the same
  detach-and-hydrate shape as `hydrateMissingProfiles`
  (`profileStore.ts:310-347`).
- A failed fetch records `status = 'error'` and backs off for 60 s rather than
  retrying per request (the `isProfileFetchBackedOff` pattern).
- **Anonymous callers have no block set.** `parseUserDid(auth) === null` → empty
  set, no DB read, no redaction. An account-less viewer hides nobody and is
  hidden from nobody.
- **The reverse rows share the same table.** A row written for a *blocker* —
  the set that answers `blockedBy(did)` — is keyed by that user's own `user_did`
  and is exactly the same shape, so one table serves both directions and the
  primary key's `user_did` prefix scan still answers the common lookup (§3.5).

### 2.4 Immediate invalidation after an in-app block

A 60 s TTL alone would mean: user taps Block, the *server* keeps sending that
author's content for up to 60 s, and the user's own timeline keeps rendering it.
The client can hide it locally at once, but the server-side guarantee would lag.

So Phase 2 adds one authenticated procedure:

- **`space.roomy.user.refreshBlocks`** (procedure, authenticated, no body —
  the DID is the auth context). Drops the in-memory memo for `auth.did` and
  re-runs `fetchBlockRecords`, upserting `user_blocks` and stamping
  `user_block_fetches`. Under mutual hiding (§7.7) it must also invalidate the
  memo entry of the block's `subject`, or the blocked account keeps reading the
  blocker until the TTL expires — the exact window this procedure exists to
  close. Fire-and-forget from the client's point of view: the
  write to the PDS has already succeeded, and a failure here self-heals at the
  next TTL expiry. Handler shape follows
  `handlers/space.roomy.room.updateSeen.ts` (validate → 401 → work →
  per-user invalidation signals).

The client calls it immediately after `putRecord`/`deleteRecord` succeeds. The
TTL remains the convergence path for a block written by *another* client.

There is nothing else for the procedure to invalidate: the reveal is not
recorded in the block set or anywhere else (§3.6), so a block's only effect on
the server's state is its membership in `hiddenBy`.

### 2.5 Decision: no index and no sweep — the reverse set is built from each account's own requests

The reverse question — "who blocked this DID?" — is the only part of §3.5's
predicate the appserver cannot answer from the viewer's own repo. Three shapes
were on the table: enumerate the viewer's space-members' repos (the original
revision's choice), index the record type in HappyView/Jetstream (§2.1's
rejected mechanism; the Appendix records the registrations it would need), or
read a repo when *its owner* is present. The third is what ships:

- **A read never fetches.** `hiddenBy(viewerDid)` answers from `user_blocks`
  alone: one indexed query for the viewer's own set, one for the reverse set. No
  DID resolution, no `listRecords`, nothing awaited.
- **An authenticated request refreshes its own account.** `warmBlockSet(did)`
  runs for every authenticated request — the router reports each caller's DID
  (`xrpc/router.ts`, installed by `appserver.ts`) — and reads that account's
  repos only when the stamp of its last attempt is older than the 60 s TTL, or
  past the 60 s error backoff. One account therefore costs at most one PDS page
  loop per cache window however often it calls, and the set of repos read is the
  set of accounts that use the appserver rather than the sum over viewers of
  their space-mates.
- **The write path stays synchronous.** `refreshBlocks` (§2.4) is awaited in the
  writer's own request, so a block placed in Roomy is enforced for the writer
  the moment it is written — and the row that answers the *blocked* account's
  reverse lookup is written by that same call.

**The staleness window, and why it is the safe direction.** A block placed in
Roomy is exact on both sides: the writer's refresh runs inside the request that
placed it, and the reverse memo of every subject is dropped when the rows are
replaced (`reverseCache.clear()` in `queries/userBlocks.ts` — the replacement
answers every blocked account's lookup, so no reverse memo survives it). What
lags is a block placed where the appserver cannot see it, such as a Bluesky
client: it is enforced for its author when that author's set is next refreshed
(their next use of Roomy) and for its target when those rows next change. Two
properties make that acceptable rather than a hole. First, an active account's
set is at most one TTL behind, because the trigger is per-request while the
stamp is per-window. Second, and decisively, the viewer's *own* block is
unaffected: `blocks(viewerDid)` is refreshed by the viewer, and that is the
direction with the security consequence. What a stale reverse set costs is that
a target keeps seeing the blocker until the blocker next uses the appserver —
the failure is "not yet hidden", never "a message the viewer was told was
hidden is served anyway", and never a case where a viewer's own block stops
being enforced.

**Why not a Jetstream consumer (answering the question against the code).**
Subscribing to one firehose over `space.roomy.user.block` and/or
`app.bsky.graph.block` and writing `user_blocks` from it would remove the PDS
page loops entirely, and it is the only shape that answers the reverse question
without reading a repo at all. It is rejected on two measurements and one
property:

- **Size, unchanged for the Bluesky half.** `app.bsky.graph.block` is globally
  enormous — ≥300k repos, mean 73 records each, ~20M records extrapolated
  (§2.1) — so indexing it means a multi-hour backfill and a permanent
  multi-million-row local index.
- **The Roomy collection alone is small, but it is not the half that needs
  help.** `space.roomy.user.block` is ours and small, so a consumer over it is
  cheap in bytes. It is not cheaper in *freshness*: Jetstream delivery lags the
  repo write by an unbounded amount — the objection §2.1 already records — while
  the PDS read that ships is exact at the moment it runs. A permanent subscriber
  and a second writer into `user_blocks` buy nothing the trigger does not
  already have for a read that is deliberately stale-tolerant.
- **The current code already satisfies the freshness that matters, more
  cheaply.** The writer's own `refreshBlocks` is synchronous and in-request
  (§2.4), so the direction with a security consequence needs no index and no
  subscriber at all. Only the *reverse* direction is allowed to be stale, and a
  target has nothing to act on.

**If it is revisited:** the decision to re-open is the one §2.1 records, and the
trigger does not change it. The appendix's `subject`-filtered HappyView query
would answer `blockedBy` in one call, but only at an ingest lag this plan still
cannot bound, and it would not make the *forward* direction fresher than the PDS
read it replaces.

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
// queries/selectMessages.ts:598-606
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

The cursor *derivation* above is what this argument rests on, and it is
unchanged — verified on `0f336883`. Only the keyset **key** moved: `#292`
(`2b68768a`) replaced an `order by e.sort_idx desc` that keyset on `e.id < ?2`
with a single key in both clauses, `coalesce(e.sort_idx, e.id) desc, e.id desc`,
backed by a matching `idx_entities_room_sort_key (room, coalesce(sort_idx, id),
id)`. That closed the boundary hazard this plan previously recorded as
pre-existing (§7.11). It did **not** make row removal safe: a `where` that drops
blocked rows still shrinks the page after the `LIMIT`, `baseRows.length` still
reads the pre-filter count against `messages`, and a fully-blocked page still
terminates the scrollback. Redaction is what keeps the cursor correct, and that
is a property of the cursor derivation, not of the page key.

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

- `baseRows.length === limit` is unchanged → `nextCursor` is correct (the
  derivation reads `baseRows`, never the tombstone).
- Pages are full → the scrollback is contiguous.
- The deep link `?message=<id>` and row highlighting still resolve.
- The client has a place to draw the indicator, which is a hard requirement.

The alternative — omit the row entirely — cannot draw a per-message indicator
at all, and is the design that produces the truncation described above. The
task's UI requirement and the pagination requirement point at the same answer.

**The tombstone is the shape for every route; the reveal is a route, not a
row.** The tombstone above is what `room.getMessages` returns for a hidden
author, for every caller including an admin who blocked them. The reveal
(§3.6) is not a third variant of this row: it is a single message fetched by id
through `space.roomy.message.getMessage`, which returns the full DTO for
exactly one class of caller and the tombstone for everyone else. The asymmetry
is deliberate and it is what keeps the fan-out one object per room — see
§3.6 for the rule and §3.4 for the surfaces that consequently never carry a
reveal.

### 3.2 The SQL

Add a blocked-author flag to the base query rather than filtering rows. The
`json_each` shape was verified against the runtime's SQLite (bun:sqlite,
SQLite 3.53.0) — a JSON array bound as a parameter and expanded inside the
predicate returns the right rows — and JSON1 is already in use in the tree
(`coalesce(json_extract(payload,'$.canonical_parent'),0) = 1`,
`handlers/space.roomy.search.messages.ts:133-140`):

```sql
-- added to the select list of both room-scope and ids-scope. The predicate is
-- the mutual block relation (visible(a, b) = a ∉ hiddenBy(b)), never a plain
-- membership test on the row's own block set.
(case when author_e.tail in (select value from json_each(?H))
      then 1 else 0 end) as blocked
```

with `?H` = `JSON.stringify([...hiddenBy(viewerDid)])`, or `'[]'` when the
viewer has none. Bound as one parameter, not one-per-DID, so the statement text
is stable and the room scope's keyset still walks `idx_entities_room_sort_key`
— the same reason `#292` left the order expression unwrapped
(`selectMessages.ts:181-185`). The parameter index is not fixed at `?H`: the
room scope gains this parameter *before* the cursor parameters, so a cursor
page binds `roomId, hidden, cursorKey, cursor`, not the current
`roomId, cursorKey, cursor` (`:230`).

In the assembly step (`selectMessages.ts:477-555`), a row with `blocked = 1`
short-circuits to the tombstone before content decoding, before the reaction /
media / link-embed maps are consulted, and before
`hydrateProfiles` (`:570-579`) would attach a name and avatar.

**The reveal is not in this statement, and that is the point.** `selectMessages`
is the room and thread page builder; every caller of it that returns a *page*
returns the same tombstones to every caller. Adding a caller-dependent widening
here would mean a per-caller shape on the fan-out path (§3.4) and a second
query variant for one surface. The reveal lives in the single-message route
instead (§3.6), so the `blocked` flag stays a boolean and `?H` is the only
parameter this feature adds.

Two further guards, because the batch queries are keyed on the page's ids and
would otherwise pull a blocked message's content into the response:

- **Reactions, embeds and link-embed data** (`:313-379`, `:432-458`) must
  exclude blocked message ids from the id list they are given,
  so a blocked message's media URLs, alt text and enriched link cards never
  enter the process.
- **Forward originals** (`:281-311`) recurse through `selectMessages` with
  `{ kind: "ids" }`, so the recursion must carry the hidden set and redact the
  embedded original when the *original's* author is blocked — a blocked
  author's words must not survive by being forwarded by somebody else. The
  forwarder's own row is redacted when the *forwarder* is hidden.

### 3.3 The other read surfaces

Each row of the §"Every route" table, with its fix:

| Surface | Fix |
|---|---|
| `message.getMessage` | Same tombstone — `selectMessages` `{ kind: "ids" }` carries the block set, so the route returns the tombstone and never the content |
| `search.messages` hits | Redact in the hydration loop (`:241`) from the hydrated `authorDid`. **Not** a Qdrant-side filter: `authorDid` is written as `""` on the backfill path (`search/backfill.ts:298`, vs the real value at `search/indexer.ts:294`) and has no payload index (`qdrantSearch.ts:177-182`), so a Qdrant `must_not` would miss every backfilled message |
| `search.messages` reply context | Redact the `reply.message` attachment (`:345`) |
| `getActivityFeed` | Redact inlined `recent_message_ids` bodies (`queries/activityFeed.ts:320-360`) and drop blocked DIDs from `latestMembers` |
| `room.getThreads` / `space.getThreads` / `room.getMetadata.recentThreads` | These read the `room_activity` projection and `threadActivity`'s `latestMessage` (`queries/threadActivity.ts:424-447`). The projection is reader-independent (`room_activity`, `schema-space.sql:402-409`), so redaction is applied **at read time** in `fetchRoomActivity` and in the `latestMembers` assembly — never in the projection, which has no viewer |
| `mention.getMentions` | Redact the `loadMentionMessages` DTOs (`queries/mentions.ts:294-300`) |
| `room.getLinks` / `space.getLinks` | A link row names the message that shared it. Redact (or drop) rows whose sharing message is authored by a blocked DID, so a blocked user's shared URLs do not surface in the links tab |
| `getReactions` | Drop blocked DIDs from the reactor list before profile resolution, so their name and avatar do not appear in the tooltip. The emoji *count* stays (§7.5) |

### 3.4 Live path, counters, push

**`#messageDiff`** carries a complete `MessageDto`
(`invalidation/types.ts:84-102`, `sync/handler.ts:508-531`). The frame is built
**once per room topic** and delivered to every subscriber through
`#deliverRoomFrame` (`sync/handler.ts:544-554`), which already loops
per-connection for its access re-check. The redaction hooks into that same
loop:

```
for (const connId of connIds) {
  ...
  if (!(await this.#canReceiveRoomContent(roomId, conn.did))) continue;
  conn.send(this.#redactForViewer(frame, conn.did, authorDid));
}
```

`#redactForViewer` returns the *same object* when the connection does not hide
the author — the overwhelmingly common case — so the change costs one set
membership test per connection and allocates only for the connections that
actually hide. The hidden set for a connection is `hiddenBy(conn.did)` (§3.5),
memoised with the same 60 s TTL discipline as `#roomAccessCache`
(`sync/handler.ts:448-480`).

**`#roomActivityDiff`** (`:572-600`) carries the author object and a preview
text (`invalidation/roomActivity.ts:118-143`); redact both per connection.
**`#roomMetadataDiff`** (`:630-666`) already iterates per user, so its unread
delta is simply not sent to a user who hides the author.
**`#mention`** (`:602-628`) carries a snapshot; redact.
**`#streamEvents`** (`:988-1010`) carries *raw event payloads* — the message body
bytes — and has no per-viewer filter at all. Today it is service-only: app-lite
subscribes only `room:` and `space:` topics (`useTopicSubscription` at exactly
two call sites, `routes/[space]/+layout.svelte:95` and
`routes/[space]/[room]/+page.svelte:127`), and the raw-event consumer is the
Discord bridge through the admin-gated `space.roomy.sync.getEvents`. §7.6
forbids user DIDs from that topic.

**Unread counters.** `applyBundle` bumps `read_positions.unread_count` for
every user tracking the room (`materialization/applyBundle.ts:184-204`) — the
materialiser is viewer-independent, but the *statement* is not required to be,
because `read_positions.user_did` is already in scope. One correlated
subquery makes the bump hide-aware without the materialiser knowing what a
block is:

```sql
update read_positions
   set unread_count = unread_count + 1, updated_at = (unixepoch() * 1000)
 where room_id = ?1
   and ?2 not in (select blocked_did from user_blocks
                   where user_did = read_positions.user_did)
   and read_positions.user_did not in (select user_did from user_blocks
                                        where blocked_did = ?2)
```

with `?2` the effective author DID (the `authorOverride` value for bridged
messages — `applyBundle.ts:223-229` already resolves it for the participation
write). Both tables live in the same read-state DB, so this is a plain
subquery, no `ATTACH`. The thread variant (`:184-196`, an `insert … select
from user_thread_activity`) takes the same predicate on `uta.user_did`.

The second clause is the mutual direction (§3.5): a user who *is* blocked by
the author does not get the bump either. Without it the counter is one-way and
the blocked account sees "3 unread" over a room whose three newest rows are
indicators.

The same author-exclusion applies to `getRoomReadPositionUsers`
(`queries/readPositions.ts:514-524`), the recipient list behind
`#roomMetadataDiff` — otherwise the DB count and the pushed delta disagree.
And to `updateSeen`'s recomputed count
(`handlers/space.roomy.room.updateSeen.ts:89`,
`select count(*) from entities where room = ? and sort_idx > ?`), which is
already viewer-scoped and gains one `and author not blocked by userDid`
clause.

**Push.** Push evaluation already loops recipients individually
(`push/evaluate.ts` — "for each recipient (excluding the author)"), so a hidden
author skips the recipient before any payload is built — in both directions,
since the test is the same `hiddenBy` membership. This matters
because the payload renders the author's name as the notification title
(`packages/app-lite/src/lib/notificationText.ts:32-50`): without the filter, a
push is a full reveal of both identity and (via the digest text) content.

**System messages are never redacted.** A system message's author is the
space itself (`selectMessages.ts:516-519`: `system` is
`author_did === stream_id`). Blocking a member must not erase "X joined the
space" notices, and the space DID is not a blockable identity.

**No surface on this page carries the reveal.** The reveal exists on exactly
one route — `space.roomy.message.getMessage`, fetched by id (§3.6) — so every
surface here is redacted for every viewer, including an admin who blocked the
author. The reason is structural rather than a policy choice: the live frames
are built once per room topic and fanned to every subscriber
(`#deliverRoomFrame`, above), so a per-admin widening there would mean building
a second frame per connection; the counters and the push evaluator do not run
with the caller present at all, so there is no caller to widen for. The table
records that per surface, because "the reveal is a route, not a row" is the
kind of sentence a later reader re-derives wrongly:

| Surface | Reveal? | Why |
|---|---|---|
| Live `#messageDiff` | **No** | Built once per room topic, fanned to every subscriber. A revealed body here would mean a second, per-connection frame — the one place this design would stop being one object per room |
| Live `#roomActivityDiff`, `#mention` | **No** | Same fan-out; previews and snapshots rather than the message |
| Unread counters, `#roomMetadataDiff` | **No** | A count, not content; it is incremented once for every user tracking the room under the mutual predicate. Reading a message you fetched by id does not create an unread row, and an admin who blocked the author has no more claim to one than anyone else |
| Push payloads, including the `dialog` digest | **No** | Delivered without the caller present. The digest is *count-based and author-named* rather than content-based: `notificationText` renders `${author} in ${room}` with body `${count} new messages` (`packages/app-lite/src/lib/notificationText.ts:34-40`), so it leaks identity and volume, never the withheld body |
| `#roomy` / space-card link previews | **No** | `SpaceRoomBadge` fetches `getSpaceSummary` — a space name and avatar, no message content, no author. There is no blocked content on this surface |
| Raw `#streamEvents` and `space.roomy.sync.getEvents` | **No** | Not per-viewer at all; §7.15 |

**The one consequence to accept, stated plainly:** an admin who blocked
someone still sees their ordinary timeline as indicators. The reveal is one
click on one row — `getMessage` by id — and it is deliberately a fetch rather
than a mode, so there is no state anywhere that makes a whole room readable to
that admin. That is the design, not a limitation of it: a stateless reveal has
nowhere to live except the route that serves it (§3.6, §7.14).

### 3.5 Mutual hiding: one block, two redacted directions

The decision (§7.7) is that both directions are redacted. The design above
absorbs it, because the predicate is symmetric by construction: **a blocked
author is redacted for a viewer when either party blocked the other.**

What changes, and what does not:

- **A new predicate, not a new pass.** §3.2, §3.3 and §3.4 all consume
  `hiddenBy(viewerDid)`, the set of authors the viewer must not see. §7.7
  redefines it from `blocks(viewerDid)` (what the viewer wrote) to
  `blocks(viewerDid) ∪ blockedBy(viewerDid)` (what the viewer wrote, plus
  everyone who wrote a block naming the viewer). Every downstream filter,
  tombstone and skip is then correct with no branching, no second code path and
  no phase: the read-time design is direction-agnostic because it never asks
  *who* blocked, only *whether this author is hidden from this viewer*.
- **The reverse set is resolved for every viewer, including the blocked.**
  The blocked user has no record in their own repo saying they were blocked —
  the evidence lives in the blocker's repo, which is public (§1.2). So
  `blocks(did)` cannot answer it alone; it becomes two lookups whose
  union is the answer:
  1. `blocks(did)` — the viewer's own repos, both collections. This is the
     §2.2 fetch, unchanged.
  2. `blockedBy(did)` — everyone whose Roomy repo holds a
     `space.roomy.user.block` naming this DID. This is a *reverse* index the
     tree does not have today, and it is the real cost of mutual hiding: the
     appserver must learn about a record in somebody else's repo, and it has
     only three ways to do it.
- **Where the reverse set comes from.** Ranked by fit (§2.5):

  | Source | Freshness | Cost | Verdict |
  |---|---|---|---|
  | HappyView `app.bsky.graph.block` index with a `filter = { field = "subject", value = did }` query | Jetstream lag (minutes, unbounded) | One index and one query lexicon (§Appendix; the appendix's Lua `filter` is exactly this lookup) | **Not in v1.** A safety property whose enforcement window "depends on HappyView's ingest lag, not on the appserver" is the same defect §2.1 rejected for the forward direction |
  | Reading a blocker's repo when *that account* authenticates | Exact for the write that placed the block (`refreshBlocks`, §2.4); otherwise as old as that account's last authenticated request | One PDS page loop per account per cache window — proportional to the accounts that use the appserver, not to the space-mates of everyone reading | **Shipped.** `warmBlockSet` in `queries/userBlocks.ts`, called for every authenticated request; a read serves `user_blocks` and never fetches |
  | Nothing — one-way only | — | — | Rejected by §7.7 |

- **`space.roomy.user.refreshBlocks` has to fan out.** §2.4 drops the memo for
  the *writer*. With mutual hiding, a block also changes what the *target*
  sees, so the procedure must additionally invalidate the cached `hiddenBy`
  entry for `subject` — otherwise the blocked account keeps reading the blocker
  for up to the TTL, which is precisely the window the procedure exists to
  close. Same call, one extra key.

**The consequence, named.** A block becomes **visible to its target**. Under
one-way hiding the blocked account could never tell; under mutual hiding, the
first thing they notice is that the blocker's messages turned into indicators,
which tells them they were blocked — and by whom, because the indicator sits on
the blocker's rows. That is the cost §7.7 accepts, and it is real: a user who
blocks someone to stop harassment without a confrontation cannot do it quietly
any more. It is also the same visibility the public record already carries, and
the same posture Bluesky ships (§1.2) — the difference is that mutual hiding
makes it *observable in the product* rather than only in the repo. This is the
one direction in which "hide" and "shield" cannot both be had: mutual redaction
is a shield, and a shield is not silent.

### 3.6 The admin reveal — the one exception to §3.1's redaction

**The rule, stated precisely.**

> A viewer may reveal a hidden message when **both** of the following hold:
>
> 1. the message's author is hidden from the viewer *because the viewer blocked
>    that author* — i.e. `authorDid ∈ blocks(viewerDid)`, not merely
>    `authorDid ∈ hiddenBy(viewerDid)`; and
> 2. the viewer holds the admin edge (`edges.label = 'admin'`) on the space
>    that materialised the message's room.
>
> Nothing else opens a tombstone. The reveal is available only for a block the
> viewer placed themselves, and only in a space they administer.

Both clauses are the rule as given — "admins should be able to reveal messages
from users *they* have blocked in spaces they are admins of". Both are
necessary: clause 2 alone would let any admin unmask anyone's block, which is
the moderation-power reading of the same sentence and is not what was asked
for; clause 1 alone would make the reveal global rather than space-scoped.

**The reveal is a read, not a state.** Looking is the whole act: the server
records nothing, the client persists nothing on the server, and no row changes.
Three consequences follow directly and each removes a piece of design the
earlier revisions carried:

- **No audit.** There is no `block_reveals` table and no write on the reveal
  path (§7.14). A read is not attributable, and the design does not pretend to
  make it so.
- **No per-block permission.** There is no `revealInSpaces` field on
  `space.roomy.user.block` (§1.1) and no `revealableBy` predicate over it. The
  gate is the space's admin edge, a property of the *space*, not of the block.
- **No client-side reveal state to reconcile.** The client holds a set of
  message ids it has fetched as revealed for the current session; nothing about
  it survives a reload, and a fresh page load shows indicators again.

**Where it is evaluated: one route, `space.roomy.message.getMessage`.** This is
the load-bearing decision of the revision, so the reasoning is stated rather
than implied.

The server has to answer "may this caller see this author's body" and the
answer is caller-dependent. Every message-returning route in §3.3 is a *page*
whose shape is shared across callers, built by `selectMessages` and fanned out
by §3.4. Widening any of them for admins would either put a caller-dependent
row shape on the fan-out path or fork the query per caller. A single,
by-id route does neither: it is already caller-scoped, it already returns one
message, and its response is shared with nobody.

So the reveal is `getMessage` returning the full DTO instead of the tombstone,
subject to the two clauses above. The gate runs in the handler, after the room
and message are resolved, which is exactly where the space DID and the caller's
DID are both in hand:

- **The author's own block set is the only set consulted.** `blocks(viewerDid)`
  is already resolved and cached (§2.3); no new query and no reverse lookup.
- **The admin check is `isAdmin(db, spaceId, did)`**
  (`auth/access.ts:124-131`) — the per-space edge, **not** the
  `APPSERVER_ADMIN_DIDS` service allowlist (`admin.ts:39-51`). The two are
  unrelated, and a check written against the wrong one would grant every
  allowlisted service DID the power to unmask every block it holds. §7.15
  restates this because the bridge's reads make the distinction concrete.
- **A viewer who is not an admin, or who is hidden from the author rather than
  hiding them, gets the tombstone** — the ordinary §3.1 path, unchanged. The
  mutual direction (§3.5) deliberately does **not** reveal: being blocked gives
  no licence to read the blocker's messages, and an admin who is blocked by
  someone has, if anything, less reason to read them.

**What the reveal carries: the full DTO, not the author-suppressed shape.** The
question "does a reveal return content, or the same author-suppressed shape used
elsewhere" is answered by what the reveal is *for*: an admin who blocked someone
and needs to read a message — a report, a dispute — has to see what was written.
A shape that suppressed the author cannot be acted on, because the decision is
about *that author*. So the revealed response is the complete `MessageDto`:
content, mime type, author name and avatar, reactions, media, link embeds, reply
context, forward originals. There is no half-revealed variant; either the
tombstone or the message.

**The reveal does not reach `selectMessages`' batch queries by accident.** §3.2
excludes hidden ids from the reaction / embed / link-data batches so a blocked
message's media URLs and enriched link cards never enter the process. The
revealed row needs them, so the batch ids are the *tombstoned* ids only — but
this is moot on the reveal path in practice: `getMessage` fetches exactly one
id, and on the reveal branch that id is not tombstoned.

**Two properties worth naming because they are easy to lose.**

- **The reveal is viewer-local and stateless.** It changes what one caller
  receives and nothing else: not the materialised row, not another admin's
  response, not a live frame to a different connection. That is the same
  property that made read-time redaction the right design (§3.1), and it is what
  keeps §7.5's reaction-tooltip hiding — which is about *other people's*
  messages — intact for the revealer.
- **The reveal is not an un-block.** The author stays hidden everywhere else:
  still no push, still no unread bump, still an indicator in the timeline, in
  search, in the activity feed and in every other surface of §3.3 and §3.4.
  Only the one fetched message is readable, and only until the page is reloaded.

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

**`blocked?: boolean` is the only field the reveal needs, and `getMessage`
carries it in both states.** A revealed fetch is a full-bodied row that is
*also* `blocked: true`: the client asked for it by id precisely because the
author is blocked, and it must keep saying so, or the viewer cannot tell the
message they are reading apart from an ordinary one. There is no second wire
field: unlike the earlier draft, a `revealed` flag would only ever describe a
row the client itself requested by id and therefore already knows it revealed.
Two states on the wire (`blocked` present or absent), and the third client
state — "fetched as revealed in this session" — is local (§4.4).

**The field is deliberately direction-blind.** It says "this author is hidden
from you", never which of the two directions produced that (§3.5). A mutual
block is two different product states — you blocked them, they blocked you —
and a single boolean cannot tell them apart; if the UI needs to, the client asks
for its own written set (`mutations/blocks.ts`'s `listBlocks`) and treats a
hidden author *absent* from it as the reverse case. That keeps the wire schema
one field and keeps the server from having to decide what to disclose. The
reveal (§3.6) needs the direction only to decide whether to *offer* the fetch,
and `listBlocks` already answers it.

**Nothing here is cached across callers.** The XRPC response cache keys on
`(nsid, params, userDid)` (`cache/queryCacheKey.ts:35-41`) and only these NSIDs
are cacheable at all: `space.getMetadata`, `room.getMetadata`, `getSpaces`,
`space.getThreads`, `space.getActivityFeed` (`cache/index.ts:36-49`). `getMessage`
is not in that set, so a revealed body cannot be served to another caller from
cache; the per-user component of the key is what would prevent it if one were
added.

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
`x-circle-bold` is the literal "blocked-circle-X" the design calls for).

`ChatMessage.svelte` computes the prop from the message it actually renders —
`message.blocked`, or `original.blocked` for a forward
(`ChatMessage.svelte:229`, `:239-264`) — and passes it to `MessageBubble`
alongside the existing props (`:384-400`). Everything else on the row is
suppressed: no toolbar, no reactions, no edit/delete/forward/select actions, no
hover affordances, no profile link, no `onAvatarClick`.

**A revealed fetch renders as an ordinary row, plus the blocked marker.** It is
not the suppressed row with content spliced into it: the suppression listed
above exists to make an indicator out of a row with nothing in it, and a
revealed row is a full `MessageDto` — body, author, reactions, media. The
render branch is therefore on `blocked` *and* on whether this row was fetched
as a reveal (§4.4), not on `blocked` alone:

| `blocked` | fetched as reveal? | Row |
|---|---|---|
| falsy | — | The ordinary row, exactly as today |
| `true` | no | Indicator in the avatar slot, no body, no toolbar, no actions |
| `true` | yes | The ordinary row, plus the "blocked" marker §4.4 specifies |

The middle row is §3.1's tombstone in the timeline; the bottom row is §3.6's
reveal, which only ever arrives from `getMessage`. A row that renders as an
ordinary message while its author is blocked is the state §4.4's marker exists
to make legible.

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

**Only surfaces that render `MessageBubble` carry the reveal.** The affordance
lives in `MessageBubble` (§4.4), so a surface inherits it by using that
component and does not by not using it — there is no second implementation and
no per-surface server predicate to keep in step:

| Surface | Reveal? | Why |
|---|---|---|
| Room timeline, and the `?message=` deep link | **Yes** | `MessageBubble` rows with a message id and a known space; this is where a moderator acts |
| `SearchResultsList` | **Yes, by inheritance** | It renders `MessageBubble` compact (`:330`), so it gets the affordance. Its duplicated reply-preview markup (`:368-412`) gets the blocked branch and **no** affordance — a preview is not a message row |
| `ActivityFeed` | **No** | Previews, one line of context, a hand-rolled row with no message id on it. It links into the room, where the affordance lives |
| `MessageContextReply` | **No** | A reply preview inside another message's body; context for a message, not a moderation target |

The rule behind the table: **the affordance belongs where a message id is
rendered as a message.** A preview is not one, and duplicating the control onto
previews would multiply the places that must agree about §3.6's predicate
without adding a way to act on it.

### 4.4 The reveal surface, client-side

The server redaction is the guarantee. The client holds a second layer because
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
it. The set is the user's **own written blocks**, read with `listBlocks`
(`mutations/blocks.ts`) so it is seeded from the records the user just wrote and
refreshed on login. The reverse direction (§3.5) is not in this set and is not
needed on the client: the server sends the tombstone for it, and the client's
job is only to render what it is given and to decide whether to *offer* a
reveal, which is a question about the viewer's own blocks.

The client layer is explicitly **belt, not guarantee**: it exists to close the
window between a local block and the server's refreshed set, and to survive a
stale cache. It is not the enforcement point and must not be described as one.

**The reveal affordance.** The tombstone row is not content-free for everybody:
an admin looking at a row for an author they blocked, in a space they
administer, gets a control on it, and it is the only interactive thing on that
row.

- **Where.** In the avatar slot's indicator position, on hover, beside the
  blocked glyph — the slot `MessageBubble` already swaps between an avatar and
  a pending-send spinner (`MessageBubble.svelte:205-233`). One more branch in
  the same `{#if}`, so nothing moves.
- **What it says.** "Show blocked message", phrased as the temporary act it is.
  Not "unblock", which this is not — the author stays blocked, stays tombstoned
  on every other surface, and the next page load hides them again.
- **When it is absent.** For every viewer who is not an admin of that space,
  and for every admin who did not block that author. This is not only a UX rule:
  the client must not *offer* an affordance the server will not honour, so the
  gate is the same two clauses the server evaluates (§3.6). `isAdmin` is already
  available in `ChatArea` (`ChatArea.svelte:54-55`, via
  `createSpaceMetadataQuery` → `space.getMetadata`, which returns
  `isAdmin: access.isAdmin` at `handlers/space.roomy.space.getMetadata.ts:339`),
  and the client's own block set answers clause 1.
- **What happens on click.** The row is replaced by the result of
  `message.getMessage` for that id (§3.6). On a full DTO the id goes into a
  session-local revealed set and the row renders as an ordinary message plus
  the blocked marker (§4.2). On a tombstone — a stale admin edge, a space the
  admin has since left — nothing changes and the indicator stays. The server is
  the arbiter; the client holds no optimistic copy of a body it never had.
- **What a revealed row shows.** The full row with a "blocked" marker on it
  (§4.2's third row), so the viewer can see that the author they are reading is
  one they blocked, and can reverse it. The reveal must never look like an
  ordinary message: an admin scanning a room should not have to remember which
  rows were blocked.

**The session-local set is the whole of the client's reveal state.** It is a
set of message ids, per message and never a per-room mode (§7.16): revealing
one row must not reveal the next. It is not persisted, so a reload returns the
room to indicators — which is the client half of §3.6's "the reveal is a read,
not a state".

**The client cannot reveal what the server did not send.** The redaction pass
runs over rows the server already redacted, so there is no cached body for a
tombstone in the common case. The one case where there is: a row cached *before*
the block (§4.4's opening premise). Those rows live in the TanStack cache, and
the client-side pass must hold them to the same rule as the server — a cached
body for a hidden author renders as the indicator unless its id is in the
session's revealed set. That is what keeps the block instant without a refetch,
and it is belt: the server's tombstone is what a fresh fetch returns.

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
content remains readable by any service DID holding admin access. §7.6 forbids
user DIDs from the raw `stream:` topics for exactly this reason; the service
path stays as it is. §7.15 re-checks that conclusion against the admin reveal
and reaches the same answer — the bridge subscribes to a `stream:` topic over
the WebSocket (`packages/discord-bridge/src/roomy/live-gateway.ts:153`), gates
on membership-or-admin (`sync/handler.ts:960-981`), and therefore neither gains
nor loses anything from §3.6.

**Mutual blocks and `did:discord:` authors.** The reverse set (§3.5) is built
from *ATProto* repos, so a `did:discord:` author can never be the blocker in a
recovered relation — they hold no repo, and they cannot write
`space.roomy.user.block`. A bridged author can still be the *blocked* party,
in either direction: their messages are redacted for a viewer who blocked them,
and §3.5's `blockedBy` does nothing for them. The asymmetry is a property of the
identity model, not of the block set, and the UI label §5 already requires
("blocked on Roomy only") is where it shows.

One consequence for the reveal: a `did:discord:` author holds no repo, so
nothing about the block lives on their side, and that is irrelevant to the
reveal — the gate is the *blocker's* admin edge in a space and their own block
set, neither of which involves the blocked party's identity beyond the DID.
A bridged author is revealable by the admin who blocked them, on exactly the
same terms as any other author. What cannot happen is the reverse: a bridged
author can never be the admin in §3.6 clause 2, because bridged DIDs hold no
member or admin edge (`queries/members.ts:146-152`), so they never appear in
`isAdmin`'s answer.

---

## 6. Phasing

Format and dispatch model follow
`packages/app-lite/docs/plans/progressive-scope-extension.md` (§Rollout
Phases). Each phase is one task, dispatched to one worker as soon as the
previous phase is merged or green, on a stacked branch.

```
next
 └── <worker>/user-blocks-p1      (record + write path, flag off)   — shipped
      └── <worker>/user-blocks-p2   (appserver block set)
           └── <worker>/user-blocks-p3   (timeline + getMessage + indicator)
                ├── <worker>/user-blocks-p4  (other read surfaces)
                ├── <worker>/user-blocks-p5  (live path, counters, push)
                └── <worker>/user-blocks-p6  (block management UX, flag on)
```

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
2. (Out-of-band, nothing depends on it) Publish the lexicon on the network as
   a `com.atproto.lexicon.schema` record — documented in the package README.
   The authority `_lexicon.user.roomy.space` resolves; the record is not in the
   repo yet (§1.3). Nothing in this phase reads the published record — the
   appserver writes the collection name as a literal and does not resolve the
   lexicon — so the record is for third-party resolution, not for the feature.
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

**Base:** `<worker>/user-blocks-p1`. **Depends on:** Phase 1 (the collection
exist for the fetch to have anything to read).

1. `packages/appserver/src/materialization/blocks.ts` — `fetchBlockRecords`
   (§2.2), modelled on `roomyProfile.ts`.
2. `user_blocks` + `user_block_fetches` in
   `packages/appserver/src/db/readStateSchema.sql`; `"11": { kind: "structural" }`
   in `readStateVersions.ts` (§2.3).
3. `packages/appserver/src/queries/userBlocks.ts` — `blocks(userDid)` (the
   viewer's own repos) served from `user_blocks` with the 60 s in-memory memo
   and the error backoff, and `warmBlockSet(did)` as the detached refresh,
   triggered by that account's own authenticated request (§2.5).
4. `hiddenBy(userDid)` (§3.5) — `blocks(userDid)` unioned with
   `blockedBy(userDid)`, the reverse index over `user_blocks` (rows whose
   `blocked_did` is the viewer). Both are indexed reads: a read never fetches.
   The rows a reverse lookup answers from are written by the blocker's own
   refresh under their own `user_did` — the same row shape as a viewer's own
   set, so one table serves both directions (§2.5).
5. `space.roomy.user.refreshBlocks` procedure (§2.4): SDK arktype schema,
   `PROCEDURE_SCHEMAS` entry, generated lexicon, route in `buildRouter`, prose
   in `packages/docs/.../prose.ts` + regenerated `nsids.generated.json`, and
   an entry in `BLOCK_RPC_SCOPES` — **not** `APPSERVER_RPCS`. The RPC scope is
   deferred with the block `repo:` scope (declared in the ceiling, listed in
   `UNREGISTERED_SCOPES`, part of the ceiling-only `blocks` tier) until it is
   registered on the HappyView API client: an entry in `APPSERVER_RPCS` lands
   the token in `base`, and HappyView rejects the whole granted set at session
   registration when any one token is unregistered, which breaks sign-in for
   every user. It invalidates the memo for the writer *and* for the block's
   subject (§3.5).
6. Wire the client: after a successful block/unblock write, fire
   `refreshBlocks` (fire-and-forget).
7. Unit tests: the union of the two collections; an empty repo; a PDS that
   404s the unknown collection; a fetch failure recorded as `status:'error'`
   with backoff; the stamp expiring and the next authenticated request
   refreshing; that a read with a cold cache starts no fetch at all; and — the
   mutual case — that `hiddenBy(B)` includes a blocker `A` who holds a block
   naming `B`, without `B`'s own repos containing anything. The PDS call must
   be stubbed — `materialization/profileFetchBounds.test.ts` is the template
   for proving every call site is deadline-bounded.

**Acceptance:** `hiddenBy` returns the correct union — the viewer's own Roomy
and Bluesky blocks plus every recovered reverse block — from `user_blocks`
alone, and no read path starts a fetch.

---

### Phase 3 — Timeline redaction and the indicator

**Base:** `<worker>/user-blocks-p2`. **Depends on:** Phase 2. **This is the
that satisfies the core requirement.**

1. Add `blocked?: boolean` to `packages/sdk/src/schemas/queries/_message.ts`;
   regenerate lexicons. One field; no `revealed` flag (§4.1).
2. `selectMessages`: carry the hidden set into both scopes; add the
   `case when … json_each` flag column to the base SQL (§3.2), renumbering the
   room-scope bind parameters; build the tombstone in the assembly step;
   exclude **tombstoned** ids from the reaction / embed / link-data batches;
   thread the hidden set through the forward-original recursion. The statement
   gains exactly one parameter, `?H`.
3. `message.getMessage`: on a tombstoned row, return the full DTO when the
   caller satisfies both of §3.6's clauses — `authorDid ∈ blocks(viewerDid)`
   (the set already resolved for `hiddenBy`'s forward half, §2.3) and
   `isAdmin(db, spaceId, did)` (`auth/access.ts:124-131`) for the space that
   materialised the room. Otherwise the row stays a tombstone. This is the only
   route that changes shape; `getMessages` returns tombstones to everyone.
4. `packages/design/`: `MessageBubble` gains `blocked`, renders the indicator
   in the avatar slot and no body (`MessageBubble.svelte:205-233`), and exposes
   the reveal affordance when its owner passes it `canReveal`;
   `icons/index.ts` gains `IconBlocked`.
5. `ChatMessage.svelte` computes and forwards `blocked` (including
   `original.blocked` for forwards) and suppresses the toolbar, reactions and
   actions on a blocked row; a row the viewer fetched as revealed renders
   ordinary plus the blocked marker (§4.2).
6. Client-side redaction pass over the cached array in `ChatArea` (§4.4), the
   own-blocks module, the session-local revealed set, and the reveal click that
   calls `getMessage` (§4.4).
7. Tests: `selectMessages` returns a full-length page with tombstones in place
   and an unchanged `nextCursor`; the tombstone carries no content, media, link
   embeds, reactions or profile fields; a forward of a hidden author's message
   is redacted; `ChatArea.loadOlderMessages` still pages past a fully-hidden
   block of history; and a page with a cursor bound correctly against the
   renumbered room-scope parameters (§3.2). For the reveal: `getMessage` returns
   the full DTO for an admin who blocked the author, and the tombstone for a
   non-admin who blocked them, for an admin who did not, for an admin the author
   blocked (the mutual direction), and for a Bluesky-sourced block; the DTO
   carries reactions, media and link embeds (§3.6); `getMessages` still returns
   the tombstone to that same admin; and no row is written anywhere on the
   reveal path.

**Acceptance:** with the flag on, a hidden author's messages appear as an
indicator-only row in the room timeline — **in both directions** — and paging
past them is uninterrupted. `message.getMessage` returns the full message to an
admin of the space who blocked that author, and a tombstone to everyone else.
No other route, and no pushed frame, carries a revealed body.

---

### Phase 4 — Every other read surface

**Base:** `<worker>/user-blocks-p3`. **Depends on:** Phase 3. Independent of
Phase 5.

1. `search.messages`: redact hits and `reply.message` (§3.3).
2. `getActivityFeed`: redact inlined message bodies and `latestMembers`.
3. `threadActivity` / `room_activity` read path: redact `latestMessage.content`
   and `latestMembers` at read time, never in the projection.
4. `mention.getMentions`: redact message snapshots.
5. `getLinks` (room + space): redact rows whose sharing message is blocked.
6. `getReactions`: drop blocked DIDs from the reactor list.
7. app-lite: the blocked branch in `SearchResultsList.svelte` (including its
   duplicated reply-preview markup) and `ActivityFeed.svelte`. The reveal
   affordance arrives with `MessageBubble` and is not re-implemented on the
   preview rows (§4.3).
8. Tests, one per surface, each asserting that no blocked content, name or
   avatar appears in the response — for every caller, admins included; none of
   these routes carries a reveal.

**Acceptance:** the §"Every route" checklist is covered end-to-end by a test
per row, and each row asserts the redaction holds for an admin of the space as
well as for an ordinary member. The reveal stays where §3.6 puts it: the single
`getMessage` fetch.

---

### Phase 5 — Live path, counters, push

**Base:** `<worker>/user-blocks-p3`. **Depends on:** Phase 3. Independent of
Phase 4.

1. `sync/handler.ts`: per-connection redaction in `#deliverRoomFrame` for
   `#messageDiff` and `#roomActivityDiff`; per-user skip in
   `#roomMetadataDiff`; redaction of `#mention`. Each guards a per-connection
   block-set lookup behind the 60 s memo, and returns the original object
   unchanged when the connection has blocked nobody (§3.4).
2. Unread counters: the correlated-subquery predicate on the `read_positions`
   bump in `applyBundle.ts`, on `getRoomReadPositionUsers`, and on
   `updateSeen`'s recomputed count (§3.4).
3. Push: skip a recipient who hides the author, before any payload is built.
4. Tests: a frame delivered to two connections where one hides the author — one
   receives the full message, the other the tombstone; the reverse pair receives
   the tombstone in both directions; a hidden message does not increment
   `unread_count` for either direction; no push is produced to a hider —
   **including an admin who placed the block and could reveal the message on a
   read path** (§3.4's table: the live path, the counters and push gain no
   exception, because none of them runs with the caller present).
   `sync/handler.ts` and `StreamManager.test.ts` are the existing harnesses.

**Acceptance:** no live frame, unread count, or push reveals a hidden author's
content, in either direction — for every viewer, admins included.

---

### Phase 6 — Block management UX and flag on

**Base:** `<worker>/user-blocks-p3`. **Depends on:** Phase 3. Independent of
Phases 4 and 5, but must not ship before them.

1. A "Blocked users" page under `routes/user/settings/blocks/`, listing the
   resolved set with its source (Roomy / Bluesky) and an unblock action;
   the nav entry beside General/Notifications/Subscription
   (`routes/user/settings/+layout.svelte:90-125`) plus the `settingsPageName`
   `switch` (`:24-35`) and the sidebar entry in
   `routes/user/settings/+page.svelte`.
2. Unblocking a Bluesky-only block: the record lives in the user's Bluesky
   collection, so the UI states that it can only be removed from Bluesky — or
   offers to delete the `app.bsky.graph.block` record too (§7.9). The list
   distinguishes "you blocked" from "you were blocked by" (§4.1), which is the
   first place the §7.7 consequence becomes visible to a user.
3. Enable `user-blocks` by default.
4. E2E: seed a block (the seeder already inserts feature flags directly —
   `packages/app-lite/e2e/seed.ts:230-235`), open the room, assert the
   indicator renders in the avatar position and the body is absent; as an admin
   who blocked that author, reveal the row and assert the body appears with the
   blocked marker, and that a second non-admin session still sees the indicator.

**Acceptance:** the flag is on, blocked users are listed and manageable, and the
E2E suite covers both the blocked and the revealed rendering.

---

## 7. Decisions

Every question this plan raised is answered: the recommendation was accepted on
each one except 7, which is reversed. The plan states the outcome rather than a
preference, and records an alternative only where a future reader would
otherwise re-propose it.

§7.12–§7.16 were added by the 2026-09-28 revision and rewritten by the
2026-10-13 one. §7.12 states the rule; §7.13–§7.16 record the consequences of
the reveal being a transient read rather than a recorded act, and every one of
them is settled — nothing here is an open question or a pending preference.

**1. Record key: `tid` (one record per block) or `literal:self` (one list
record)?**
**Decided: `tid`.** It mirrors `app.bsky.graph.block` exactly, makes the
bootstrap a copy, avoids a read-modify-write race between two devices, and
preserves per-block `createdAt`. The cost is that unblocking needs the rkey,
which the client learns from the same `listRecords` read it already performs.

**2. Public repo record, or appserver-only storage?**
**Decided: public repo record.** atproto has no private records; the two
real alternates are an appserver-only table (private but trapped in one
appserver, no cross-app blocking, no portability) or an encrypted record (no
precedent, key management is a bigger project). Bluesky's own block record is
public and its lexicon says so. The consequence to accept explicitly: a Roomy
block list is world-readable and the blocked account can learn it is blocked.
The appserver-only table in the readstate DB — same read paths, same
enforcement, no record and no `repo:` scope — remains the fallback if the
posture is ever revisited, with the record added later. It would change Phase 1,
not Phases 2–6, and §3.5's reverse index would not exist in that variant: with
no public record there is nothing to recover, so the reverse direction would be
unimplementable and 7 would have to revert.

**3. A tombstone row, or omit the message entirely?**
**Decided: tombstone.** It is what makes the avatar-position
indicator possible at all, and it is what keeps pagination correct: the row
keeps its slot, so `baseRows.length === limit` and the cursor derivation
(`selectMessages.ts:598-606`) are untouched. Omitting the row produces short
pages and, when a whole page is blocked authors, silently terminates the
scrollback (`ChatArea.loadOlderMessages` → `hasMore = false`). The tombstone
carries `id`, `sort_idx`, `timestamp`, `authorDid` and `blocked: true`;
everything else is empty or absent. Omission would require fixing the
pagination defect first — by moving the filter into the SQL `where` and
re-deriving the cursor from a filtered-but-full page — which is a larger change
to the same statement; §3.1 shows why `#292` did not make it safe.

**4. Does a block suppress the blocked user's push notifications and unread
counts?**
**Decided: yes, both.** Both are reveals: the push payload renders the
author's name as its title (`lib/notificationText.ts:32-50`), and an unread
badge that counts a message you cannot open is a visible inconsistency
("3 unread", room shows nothing). Both fixes are per-user and cheap (§3.4), and
both tests take the mutual predicate (§3.5) — the suppression is not one-way.

**5. Reaction tooltips: hide a blocked user's name from other people's
messages, or only from their own?**
**Decided: hide.** A block means "I do not want to see this account" —
a name and avatar appearing in a reaction tooltip on somebody else's message
defeats that. Keep the emoji count (it is not identity), drop the reactor's
name and avatar from the list. Cheap, and reversible. The same hiding applies
to a reactor who blocked the *viewer* (§3.5).

**6. Raw `#streamEvents` frames carry the message body and have no per-viewer
filter. Restrict stream topics to service DIDs?**
**Decided: restrict.** Today only the Discord bridge subscribes to a
`stream:` topic, through the admin-gated `space.roomy.sync.getEvents`; app-lite
subscribes only `room:` and `space:` (`routes/[space]/+layout.svelte:95`,
`routes/[space]/[room]/+page.svelte:127`). Because the frame carries
unredacted event payloads, a user-facing connection subscribed to a raw stream
topic would bypass every block in this plan. Forbid user DIDs from `stream:`
topics — the check exists at `#canReceiveStream`
(`sync/handler.ts:960-980`), which today gates on membership alone — and note it
in the sync docs.

**7. Direction of hiding: one-way, or mutual?**
**Decided: mutual — both directions are redacted.** The blocker stops seeing
the blocked, and the blocked stops seeing the blocker. §3.5 carries the design;
no new phase, because every surface in §3–§4 already consumes one predicate
("authors hidden from this viewer") and only that predicate's definition
changes.

**The consequence, named and accepted: a block becomes visible to its target.**
Mutual redaction replaces the blocker's messages with indicators on the blocked
account's screen, so the blocked account can tell it was blocked, and by whom —
the indicator sits on the blocker's own rows. One-way hiding was silent; this is
not, and there is no design that is both mutual and silent. The cost is
concrete: a user who blocks to stop harassment without inviting a confrontation
cannot do it quietly any more, and a block now carries a social signal beyond
the public record it already was (§7.2, §1.2). The gains are that a block is a
shield rather than only a filter, and that it matches the mutual semantics users
expect from Bluesky.

**What it costs in the appserver, stated plainly:** the blocker's repo is the
only place the reverse fact lives, so the reverse set must be *recovered* from
public repos (§3.5). That is a `blockedBy` predicate over `user_blocks`, whose
rows are written by the blocker's own authenticated refresh (§2.5) — all in
Phase 2, none of it a new phase or a new read path. There is no
`space.roomy.user.getBlocks` query and no fan-out on `refreshBlocks` beyond the
writer and the block's subject: the client reads its own blocks straight from
its own repo with `listBlocks` (`mutations/blocks.ts`), and the server never
needs to answer "who blocked me" over HTTP.

**8. Should blocking in Roomy also write an `app.bsky.graph.block` record?**
**Decided: no.** Blocking on Roomy is a Roomy act; silently changing a
user's Bluesky graph would surprise them, and it would need the Bluesky
collection in the OAuth scope. The Bluesky direction stays read-only. Revisit
if users ask for it — the mirrored record shape makes it a one-line addition.

**9. How should an imported Bluesky block be unblocked from Roomy?**
**Decided: delete the `app.bsky.graph.block` record** (the user owns
it; the client can write it), and label it as a Bluesky block in the list so
the action is not surprising. The alternative — read-only imported blocks that
must be removed in Bluesky — is more conservative but leaves a dead entry in
the list with no explanation of why it cannot be acted on.

**10. Does the block set need to cover bridged `did:discord:` authors in v1?**
**Decided: yes, structurally, with an honest label.** The mechanism
already covers them for free (the author edge *is* the `did:discord:` DID —
`packages/sdk/src/schema/events/message.ts:54-74`), and the block UI can source
those DIDs from message authors. There is no Discord↔ATProto identity link in
the tree, so a Bluesky block will not transfer, and the UI must say
"blocked on Roomy only" for these — which is the same distinction the client
already draws with its `isBridged` marker. A bridged author can be blocked but
can never be the *blocker*, since they hold no repo to write a record to
(§5) — the reverse set is ATProto-only by construction.

**11. Pre-existing pagination hazard: fix it in this project?**
**Resolved — fixed in the tree, ahead of this plan.** The hazard was that the
room query ordered by `e.sort_idx desc` and keyset on `e.id < ?2`
(`selectMessages.ts:194` vs `:206` at `caa71df0`), which can skip or duplicate
rows at a page boundary for bridged messages carrying `timestampOverride`.

`#292` (commit `2b68768a`, "(appserver) page the room timeline on the key it
sorts by") fixed exactly that clause. Verified on `origin/next` (`0f336883`,
which contains `2b68768a`):

- The page orders by `coalesce(e.sort_idx, e.id) desc, e.id desc`
  (`selectMessages.ts:225`) and keysets on the *same* expression with an id
  tie-break — `coalesce(e.sort_idx, e.id) < ?2 or (coalesce(e.sort_idx, e.id)
  = ?2 and e.id < ?3)` (`:221-224`).
- The cursor id is resolved to its own timeline key before the compare
  (`resolveCursorKey`, `:157-162`).
- The in-memory sort gained the matching id tie-break (`:592-596`).
- `idx_entities_room_sort_key (room, coalesce(sort_idx, id), id)` backs it
  (`schema-space.sql:62-63`).

No action is required here, and no part of this project touches the key.

**What `#292` did not change, and why it still matters to blocks:** the cursor
*derivation*. `selectMessages` still sets `nextCursor = messages[0]?.id ?? null`
only `if (baseRows.length === limit)` (`:598-606`), so a filter that removes
rows after the `LIMIT` still yields short pages and still terminates the
scrollback — on a page key that is now correct, which makes the failure *more*
visible, not less. The tombstone decision (§7.3) rests on that derivation, and
it is unchanged. Confirmed by reading `origin/next` at `0f336883`.

**12. May an admin reveal a message hidden by a block they placed?**
**Decided: yes — for their own blocks, in spaces where they hold admin, as a
transient read.** The rule is §3.6, stated there in full. This is an
**exception to §7.7, not a reversal of it**: mutual redaction stands, and the
reveal opens a tombstone for one principal — the admin who wrote the block — in
one scope — a space where that admin holds the admin edge — and nowhere else.

**Why it is not a widening of the moderation model.** The tree has no
permission system for this to attach to (§7.13), and the alternative reading of
the same sentence — any admin may reveal any block — is a real change to what
blocking means: it would turn a user's block into something an admin can
override, in spaces the user may have nothing to do with. The decision taken is
the narrower one and is the one the requirement states. It is worth naming
plainly because the two readings are one word apart and only one of them is a
safety feature.

**The act is a read, and that is what shapes everything below.** The admin
looks at a message; nothing is recorded, nothing is granted, and nothing
persists. The single route that serves it is `space.roomy.message.getMessage`
(§3.6): every other surface — the timeline, search, the activity feed, the live
frames, the counters, push — is redacted for that admin exactly as it is for
everyone else. §3.4 tabulates that per surface.

**What it costs, stated plainly.** The reveal is a genuine hole in the
invariant §3 built, and it is the *only* one. §3.1's "content is not revealable
through any route" is now "…except by the admin who blocked the author, in a
space they administer, for their own block, one message at a time". Three
limits keep it narrow, and all three are properties of the design rather than
policy promises:

- **It is per-message and per-fetch.** There is no mode and no stored flag
  (§7.16): the widened response is produced by one request for one id, and a
  reload brings the indicators back.
- **It is space-scoped by the admin edge.** The gate is
  `isAdmin(db, spaceId, did)` for the space that materialised the room, so an
  admin who blocks someone reads them in the spaces they moderate and nowhere
  else.
- **It cannot be reached by a service identity.** The gate is the per-space
  admin edge, never the `APPSERVER_ADMIN_DIDS` allowlist (§7.15).

**The limit that is not a bug, and should be said out loud:** the reveal
exists only where a message id is fetched as a message. An admin scanning a
room, a search result list or the activity feed sees indicators; the reveal is
one click on one row, and then one message is readable. That is the design, not
a gap to be closed later — a stateless reveal has nowhere to live except the
route that serves it.

**13. What is the mechanism behind the exception — a per-space setting on the
block, or a role permission?**
**Decided: neither. The gate is the space's admin edge, and the block record
carries no reveal field.** The earlier revisions proposed a `revealInSpaces`
array on `space.roomy.user.block` and a `revealableBy` predicate over it; both
are **removed** (§1.1). They existed to keep a *persistent* exception in the
user's hands. Once the exception is a transient read that changes no state
(§7.12), there is nothing for the user to grant and nothing to record, so a
per-block permission would add a field, a UI, a client-enforced promise the
server cannot verify, and a second gate to keep in step — for no gain.

The two shapes that were rejected, and why, are worth one line each because
they will be re-proposed otherwise:

| Shape | Verdict |
|---|---|
| `revealInSpaces` array on the block record (the earlier recommendation) | Removed. It made the reveal a standing permission attached to a permanent record. A read needs no permission to grant and no field to carry one |
| A role permission (a moderation capability on the `admin` edge or a new role kind) | Rejected, and not implementable in this tree today: a role carries only *room* access — `role_rooms.permission` is `check(permission in ('read','readwrite'))`, written by `space.roomy.setRoleRoomPermission` whose type is `'read' \| 'readwrite' \| null` — and it would answer a different question (delegating moderation to a non-admin), not *whose* block may be read |

**14. Is a reveal audited, or attributable to the admin who performed it?**
**Decided: no. Nothing is recorded, and the plan does not pretend otherwise.**
The earlier revisions recommended a `block_reveals` table with one row per
reveal. A read is not an act a user performs on a resource; it is the ordinary
consequence of a permission they hold, and recording every fetch would either
write to the hottest read path in the system (`getMessages`/`getMessage`) or
invent a new event for something that changes no state. The reveal is
therefore **not** attributable, and §3.6 says so rather than implying a
guarantee it does not keep:

- No table, no write, and no audit on the reveal path.
- No client-side record either: the session-local revealed set (§4.4) is not
  persisted, so there is nothing to surface later.
- The blocked user cannot learn that a reveal happened — which follows from
  there being nothing to learn, not from a policy about disclosure.

**15. Do the Discord bridge's service-DID reads interact with the reveal?**
**Decided: no change, in either direction.**

The facts, verified:

- The bridge subscribes to a **`stream:` topic** per space over the sync
  WebSocket (`packages/discord-bridge/src/roomy/live-gateway.ts:153`, and
  again on every reconnect at `:180-184`), and consumes `#streamEvents` frames
  (`:190-193`). That frame carries raw event payloads —
  `events.map(e => ({ idx, user, payload: e.event }))`
  (`sync/handler.ts:1000-1010`) — with no per-viewer filter at all.
- The stream gates are membership-or-admin and do not consult blocks:
  `#canReadStream` (`sync/handler.ts:960-980`) and its delivery-time twin
  `#canReceiveStream` (`:960-981`) both compute
  `!access.isBanned && (access.isMember || access.isAdmin)`.
- The bridge authenticates as its **own ATProto account** — a real DID with a
  repo, `ATPROTO_BRIDGE_DID` + `ATPROTO_BRIDGE_APP_PASSWORD`
  (`packages/discord-bridge/src/env.ts:16-18`), used to fetch a connection
  ticket and connect (`live-gateway.ts:128-136`). On the HTTP side it presents
  that account's service-auth JWT to `DirectXrpcClient(appserverUrl,
  APPSERVER_DID)` (`packages/discord-bridge/src/roomy/space-manager.ts`).
- The admin-gated HTTP path, `space.roomy.sync.getEvents`, is gated by
  `requireAdmin` against `APPSERVER_ADMIN_DIDS` (`handlers/space.roomy.sync.getEvents.ts:7-9`,
  `admin.ts:39-51`) — a **service allowlist**, which is a third notion of
  "admin" distinct from both the per-space admin edge (§3.6 clause 2) and from
  §7.6's topic restriction. No TypeScript call site in either the bridge or
  app-lite invokes `getEvents`; the bridge's live read path is the WebSocket.

**Why neither is affected.** The bridge is not a viewer: it holds no blocks and
is never the *blocker* in §3.6's predicate, so the reveal cannot open anything
for it, and it is not in `hiddenBy` for anyone either. And the service path is
not per-viewer in the first place — it returns raw events to a service DID, so
it bypasses the redaction §3.1 added, by construction. That asymmetry is
pre-existing, is what §7.6 addresses for `stream:` topics, and is unchanged by
the reveal in either direction.

**The one thing this section exists to prevent:** §3.6's gate must not be
implemented anywhere near a service identity. `APPSERVER_ADMIN_DIDS` is a
process-wide allowlist and the space admin edge is per-space and per-user; the
two are unrelated, and a check written against the wrong one would grant every
allowlisted service DID the power to unmask every block it holds — which, since
services may hold blocks, is not hypothetical. §3.6's clause 2 is
`isAdmin(db, spaceId, did)` (`auth/access.ts:124-131`), the space-edge check,
and the plan says so at the call site.

**16. Is a reveal per-message, or a mode the admin turns on?**
**Decided: per-message, and it is the only shape §3.6 supports.**

The requirement's own phrasing is per-message — *"reveal hidden messages… in a
space"* — and the design follows it: each tombstone is opened by acting on that
row, and §4.4's affordance lives on the row it opens. A mode ("reveal all
blocked messages in this space") is a different feature, and with the reveal
now stateless (§7.12, §7.14) it is not merely a design preference but a
different mechanism:

| | Per-message (decided) | A sticky mode |
|---|---|---|
| Server shape | One `getMessage` fetch widened for one id, gated per request | Needs a persistent per-(admin, space) flag somewhere, or a client-side set that re-fetches every blocked row on load |
| State written | **None** | A flag to store, or a client cache to persist |
| What the client does | Marks one id revealed for the session | Marks the space revealed; re-fetches every blocked row |
| Reversibility | Automatic — the next page load hides the row again | Needs an explicit "hide again", and until then the block is not in force for that admin |

The per-message shape is what keeps the exception acceptable: narrow,
momentary, and requiring no state to hold it. A mode would need state, and the
whole point of §7.12 is that there is none.

---

## Appendix — if HappyView is nonetheless required

Recorded so the §2.1 decision can be revisited on evidence, and because it is
the obvious eventual home for §3.5's reverse lookup: a `db.query` filtered on
`subject` answers "who blocked this DID" in one call, which is exactly the
`blockedBy(did)` query the per-account trigger stands in for. What it cannot yet
do is answer it *freshly* — Jetstream lag is the same objection §2.1 records,
and the PDS read that ships is exact at the moment it runs (§2.5). Indexing
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
eventual consistency standing between a block and its enforcement — the last of
which is now the whole objection, since §3.5 makes a *reverse* lookup a
security-relevant read rather than a convenience.

---

## References

**In-tree — read paths**
- `packages/appserver/src/queries/selectMessages.ts` — cursor key `:157-162`,
  room SQL `:169-231`, `where` `:219-220`, keyset/order/limit `:221-226`, ids
  scope `:232-275`, forward recursion `:281-311` (recursive call `:305-309`),
  batch queries `:313-379` `:432-458`, assembly `:477-555`, hydration
  `:570-579`, cursor `:598-606`
- `packages/appserver/src/handlers/space.roomy.room.getMessages.ts:41-49`
  (`openSpaceDbForEntity` — the space-scoped DB the reveal's `?R` is resolved
  against)
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
- `packages/appserver/src/handlers/space.roomy.message.getMessage.ts:44` — the
  one route §3.6 widens: it resolves the room and the space before the
  tombstone/reveal decision
- `packages/appserver/src/materialization/blocks.ts` and
  `packages/appserver/src/queries/userBlocks.ts` — `fetchBlockRecords`, the
  `blocks` / `blockedBy` / `hiddenBy` predicates §3.6's gate reads, and
  `warmBlockSet`, the per-account refresh (§2.5)
- `packages/appserver/src/xrpc/router.ts` — `setOnAuthenticated`, the hook that
  reports every authenticated caller's DID; installed in `appserver.ts`

**In-tree — the admin reveal (§3.6, §7.12–§7.16)**
- `packages/appserver/src/auth/access.ts:124-131` — `isAdmin(db, spaceId, did)`,
  the space-edge check §3.6 clause 2 is written against; `spaceAccessCached`
  memoisation at `:145-160`
- `packages/appserver/src/xrpc/authGuards.ts:63`, `:91` — the member-or-admin
  read gates `requireSpaceAccess` / `requireSpaceRead`
- `packages/appserver/src/handlers/space.roomy.space.getMetadata.ts:339` —
  `isAdmin: access.isAdmin`, what the client's affordance gate reads
- `packages/appserver/src/admin.ts:39-51` — `requireAdmin` against
  `APPSERVER_ADMIN_DIDS`: the service allowlist, which is **not** §3.6's gate
  and must not be used as one
- `packages/appserver/src/handlers/space.roomy.sync.getEvents.ts:7-9`
- `packages/appserver/src/cache/queryCacheKey.ts:35-41` — the per-caller cache
  key; `cache/index.ts:36-49` — the cacheable NSID set (no message query)
- `packages/appserver/src/db/schema-space.sql:277-302` — `roles`,
  `member_roles`, `role_rooms`; `:298-300` the `read|readwrite` check that
  makes a role a room-access grant and not a moderation permission (§7.13)
- `packages/sdk/src/schema/events/roles.ts:93-97` —
  `space.roomy.role.setRoleRoomPermission`, the only permission a role carries
- `packages/appserver/src/queries/notificationState.ts:60-107` — the digest's
  `unseen_count` and `first_unseen_at` (§3.4's push row)
- `packages/appserver/src/push/evaluate.ts:159-168` — `enumerateRecipients`;
  `:175-195` `buildMessagePayload` (author name + truncated content)

**In-tree — live path, counters, push**
- `packages/appserver/src/sync/handler.ts` — `#canReceiveRoomContent :448-480`,
  `#routeMessageDiff :508-531`, `#deliverRoomFrame :544-555`,
  `#routeRoomActivityDiff :572-600`, `#routeMentionDiff :602-628`,
  `#routeRoomMetadataDiff :630-666`, `#canReceiveStream :960-980`,
  `#sendStreamEvents :988-1010`
- `packages/appserver/src/invalidation/inferSignals.ts:295-308`, `:339`
- `packages/appserver/src/invalidation/roomActivity.ts:118-143`
- `packages/appserver/src/materialization/applyBundle.ts:184-204`, `:223-229`
- `packages/appserver/src/push/evaluate.ts`
- `packages/app-lite/src/lib/notificationText.ts:32-50`

**In-tree — storage and patterns**
- `packages/appserver/src/db/readStateSchema.sql` — `read_positions :57-77`,
  `pro_role_grants :209`
- `packages/appserver/src/db/readStateVersions.ts:53`, `:112`
- `packages/appserver/src/db/schema.sql` / `schema-space.sql` —
  `idx_entities_room_sort_key`, added by `#292` (`2b68768a`)
- `packages/appserver/src/db/schema-space.sql` — `room_activity :402-409`,
  `comp_bans :306-311`, `edges :65-75`,
  `idx_entities_room_sort_key :62-63`
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
- `packages/sdk/src/schemas/frames/messageDiff.ts:15-30`
- `packages/sdk/src/sync/diff.ts:18-38`, `sync/router.ts:122-136`
- `packages/sdk/src/schema/events/message.ts:54-74`
- `packages/app-lite/src/lib/config.ts:3-52`, `:134-157`, `:144`
- `packages/app-lite/scripts/build-prod.sh:49-138`, `:165-220`
- `packages/app-lite/src/lib/client.ts:19-28`
- `packages/app-lite/src/lib/queries/messages.ts`
- `packages/app-lite/src/lib/components/chat/ChatArea.svelte` — `mergeTimeline
  :85-87`, `loadOlderMessages :152-158`, `Virtualizer :482-512`
- `packages/app-lite/src/lib/components/chat/ChatMessage.svelte:229`,
  `:239-264`, `:384-399`
- `packages/app-lite/src/lib/components/chat/timeline.ts`
- `packages/app-lite/src/lib/components/chat/MessageContextReply.svelte`
- `packages/app-lite/src/lib/components/chat/embeds/SpaceRoomBadge.svelte:26-42`
  — the `space.getSpaceSummary` badge: name and avatar, no message content
  (§3.4's `#roomy` preview row)
- `packages/app-lite/src/lib/notificationText.ts:25-52` — the digest and message
  notification strings (§3.4's push row: identity and volume, not body)
- `packages/app-lite/src/lib/components/search/SearchResultsList.svelte:330`,
  `:368-412`
- `packages/app-lite/src/lib/components/feed/ActivityFeed.svelte:181-195`,
  `:231`
- `packages/app-lite/src/routes/[space]/+layout.svelte:95`
- `packages/app-lite/src/routes/[space]/[room]/+page.svelte:127`
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

**Related work**
- `#292` = `2b68768a`, "page the room timeline on the key it sorts by" —
  resolved the pagination hazard this plan recorded as §7.11

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
