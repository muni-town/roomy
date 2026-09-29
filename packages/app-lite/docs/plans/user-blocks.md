# User-level blocks — Implementation Plan

**Date:** 2026-09-26 (revised 2026-09-27, 2026-09-28)
**Status:** Ready to dispatch. §7 is a decision record — every open question is
answered (§7.7 and §7.11 revised 2026-09-27; §7.12–§7.16 added 2026-09-28 with
the admin-reveal exception, §3.6).

**Revision 2026-09-28 — the admin reveal.** A space admin may reveal a hidden
message in a space they administer, for blocks they placed themselves. The rule
is stated in §3.6 and decided in §7.12; the open questions it leaves — the
per-space personal setting versus a role permission, the audit, the service
path, and whether a reveal is per-message or a mode — are §7.13–§7.16, each
with a recommendation. It **adds an exception** to §7.7's mutual redaction; it
does not reverse it. Every constraint this plan stated before that revision
still holds for every viewer who is not an admin revealing their own block, and
§3.4/§4.4 are the two places that said "no exception exists" and now say what
the exception is.
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
author's content, and therefore every route that has to be held to §3.6's
predicate once the admin reveal exists. Each row is a distinct leak surface,
not a variation of one:

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
          "revealInSpaces": {
            "type": "array",
            "description": "Spaces where the blocker permits an admin of that space to reveal their own blocked messages (§3.6, §7.13). Absent or empty means no reveal anywhere — the field fails closed, and a record written before this field existed reveals nothing. Only blocks the blocker placed themselves are ever revealable; the value is a promise the client keeps, not one the server can verify (§7.12).",
            "items": { "type": "string", "format": "did" }
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

**`revealInSpaces` is the one field that does not mirror,** and the asymmetry
is deliberate (§7.13). A Bluesky block has no equivalent because Bluesky has no
admin-reveal feature; the conversion the mirroring buys is one-directional for
this field — a Bluesky block imports with `revealInSpaces` absent (so it
reveals nothing, ever), and a Roomy block written back to Bluesky drops it.
That is the correct default in both directions: an imported block was asserted
in another app with different semantics, and the user did not opt in to a
reveal there.

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
  set, no DB read, no redaction. An account-less viewer hides nobody and is
  hidden from nobody.
- **The reverse rows share the same table.** A row written for a *candidate
  blocker* — fetched to answer `blockedBy(did)` — is keyed by that user's own
  `user_did` and is exactly the same shape, so one table serves both
  directions and the primary key's `user_did` prefix scan still answers the
  common lookup (§3.5).

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

The same call covers a change to `revealInSpaces` (§3.6, §7.13): turning a
space's reveal on or off rewrites the block record, so the resolved set the
appserver memoises has to be dropped for the writer the same way. There is no
separate procedure for it — a reveal permission is a property of the block, and
the block is what `refreshBlocks` re-reads.

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
(case when author_e.tail in (select value from json_each(?N))
      then 1 else 0 end) as blocked
```

with `?N` = `JSON.stringify([...hiddenBy(viewerDid)])`, or `'[]'` when the
viewer has none. Bound as one parameter, not one-per-DID, so the statement text
is stable and the room scope's keyset still walks `idx_entities_room_sort_key`
— the same reason `#292` left the order expression unwrapped
(`selectMessages.ts:181-185`). The parameter index is not fixed at `?N`: the
room scope gains this parameter *before* the cursor parameters, so a cursor
page binds `roomId, hidden, cursorKey, cursor`, not the current
`roomId, cursorKey, cursor` (`:230`).

In the assembly step (`selectMessages.ts:477-555`), a row with `blocked = 1`
short-circuits to the tombstone before content decoding, before the reaction /
media / link-embed maps are consulted, and before
`hydrateProfiles` (`:570-579`) would attach a name and avatar. A row with
`blocked = 2` is the §3.6 admin reveal: it assembles in full and carries
`revealed: true` alongside `blocked: true`.

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

**Which of these surfaces gain the admin exception, and which do not.** The
rule (§3.6) is client-*pull*, so the default answer for everything the server
*pushes* is "no exception", and the plan has to say so surface by surface
rather than leave it implied:

| Surface | Gains the exception? | Why |
|---|---|---|
| Room timeline (`getMessages`) | **Yes** | The caller is present, the space is known, and §3.6's predicate is evaluated in the same statement that builds the tombstone |
| Single message (`getMessage`) | **Yes** | Same statement, `{ kind: "ids" }`; the handler already resolves the room, so it resolves the space the same way |
| Search hits and reply context | **Yes** | The caller is present and the space is known per hit; redaction happens in the hydration loop, so the reveal is one predicate there |
| Activity feed, board previews, participants | **Yes** | Caller-scoped reads of a space the caller named; the same predicate applies in the read-time redaction already specified |
| Mentions, link index, reactions | **Yes** | Caller-scoped, space-scoped, read-time |
| Forwarded copies, reply previews, client cache | **Yes** | Client-side consequences of a revealed row; §4.4 carries them |
| Live `#messageDiff` | **No** | A frame is built once per room topic and fanned to every subscriber (§3.4, `#deliverRoomFrame`). Delivering a *revealed* body therefore means building a second, per-connection frame for the connections that hold the exception — the one place this design would stop being one-object-per-room. The alternative is a second round trip after the fact |
| Live `#roomActivityDiff`, `#mention` | **No** | Same fan-out; previews and snapshots, not the message |
| Unread counters, `#roomMetadataDiff` | **No** | The counter is a count, not content, and it is incremented once for every user tracking the room (`applyBundle.ts:184-204`); an admin who revealed a message does not thereby acquire an unread row for it. Revealing is reading a page, not receiving |
| Push payloads, including the `dialog` digest | **No** | A push is delivered without the caller present. The digest's `count` and `first_unseen_at` come from `notification_state` and its `unseen_count` (`queries/notificationState.ts:60-107`), and the digest's `authorName` from the `message`-type fact build (`push/evaluate.ts:175-195`) — but the payload is *count-based and author-named* rather than content-based: `notificationText` renders `${author} in ${room}` with body `${count} new messages` (`packages/app-lite/src/lib/notificationText.ts:34-40`). So the digest leaks identity and volume, never the withheld body |
| `#roomy` / space-card link previews | **No** | `SpaceRoomBadge` fetches `getSpaceSummary` — a space name and avatar, no message content, no author. There is no blocked content on this surface to reveal |
| Raw `#streamEvents` and `space.roomy.sync.getEvents` | **No** | Not per-viewer at all; §7.15 |

**The consequence to accept, stated plainly:** an admin who reveals a message
sees it on the next read of the room, not in the live frame that delivered it.
For a moderation action that is a real difference — the message arrives as an
indicator, and the reveal is one click behind it — and it is the price of
keeping the fan-out one object per room. If the delay is judged unacceptable
later, the fix is a per-connection rebuild for connections whose reveal set is
non-empty, which is a change to `#deliverRoomFrame` and nothing else.

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
  `getBlockedDids(did)` cannot answer it alone; it becomes two lookups whose
  union is the answer:
  1. `blocks(did)` — the viewer's own repos, both collections. This is the
     §2.2 fetch, unchanged.
  2. `blockedBy(did)` — everyone whose Roomy repo holds a
     `space.roomy.user.block` naming this DID. This is a *reverse* index the
     tree does not have today, and it is the real cost of mutual hiding: the
     appserver must learn about a record in somebody else's repo, and it has
     only three ways to do it.
- **Where the reverse set comes from.** Ranked by fit:

  | Source | Freshness | Cost | Verdict |
  |---|---|---|---|
  | HappyView `space.roomy.user.block` index with a `filter = { field = "subject", value = did }` query | Jetstream lag (minutes, unbounded) | One index and one query lexicon (§Appendix; the appendix's Lua `filter` is exactly this lookup) | **Not in v1.** A safety property whose enforcement window "depends on HappyView's ingest lag, not on the appserver" is the same defect §2.1 rejected for the forward direction |
  | Appserver-side enumeration of space members' repos via `listRecords` | Fresh on every refresh | One PDS round-trip per member the appserver does not already have an answer for | **In v1, bounded.** The appserver already knows every member DID in the viewer's spaces and already reads PDSs with a per-request deadline (§2.2). Cache each *candidate blocker's* block set in `user_blocks` under their own `user_did` — it is the same row shape, keyed by the author rather than the viewer — and invalidate with the same TTL plus the `refreshBlocks` write-through (§2.4) |
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

> A viewer is permitted to reveal a hidden message when **all** of the
> following hold:
>
> 1. the tombstone's author is hidden from the viewer *because the viewer
>    blocked that author* — i.e. `authorDid ∈ blocks(viewerDid)`, not merely
>    `authorDid ∈ hiddenBy(viewerDid)`;
> 2. the viewer holds the admin edge (`edges.label = 'admin'`) on the space
>    that materialised the message's room; and
> 3. the block's `space.roomy.user.block` record lists the space that
>    materialised the room in its `revealInSpaces` array (§1.1, §7.13).
>
> Nothing else opens a tombstone. In particular the reveal is **not** available
> for a block that was imported from Bluesky (`source = 'bluesky'`), because
> that record has no such field and the user asserted the block in another app.

Clauses 1 and 2 are the rule as given — "admins should be able to reveal
messages from users *they* have blocked in spaces they are admins of". Both are
necessary: clause 2 alone would let any admin unmask anyone's block, which is
the moderation-power reading of the same sentence and is not what was asked
for; clause 1 alone is the §7.13 personal setting considered on its own.
Clause 3 is the mechanism §7.13 recommends for reconciling the two, recorded as
an open question rather than a decision; the array is a list of space DIDs and
nothing else — no "all spaces" sentinel, because a sentinel would silently cover
spaces the user joins later, and the reveal should be a promise made about a
space rather than a standing permission the user keeps re-granting.

**A third predicate, not a widening of the second.** §3.5 made
`hiddenBy` direction-agnostic on purpose: it never asks *who* blocked. The
admin reveal is precisely a question of *who*, so it must not be folded into
`hiddenBy` — doing so would make `hiddenBy` directional again and re-open every
surface §3.5 closed. It is a separate, strictly narrower relation, the set of
DIDs for which *this* caller may lift *their own* redaction:

```ts
// queries/userBlocks.ts — the fourth and last predicate over the block set.
// revealableBy(viewerDid, spaceId) ⊆ blocks(viewerDid) ⊆ hiddenBy(viewerDid).
// Empty for an anonymous viewer, and empty when the caller is not an admin of
// that space — the admin check is the first thing it does, so the
// non-admin case costs nothing beyond the memoised access lookup.
```

Evaluated once per call site, not per row, and memoised on the same 60 s
discipline as the rest of the block set.

**Where it is evaluated: `selectMessages`, in the same SQL as the flag.**

The tombstone is produced by one expression, and the reveal is the same
expression with the predicate widened rather than a second column. The base-row
flag becomes a two-value column:

```sql
-- §3.2's blocked flag, extended. `?H` is hiddenBy(viewerDid) and `?R` is
-- revealableBy(viewerDid, <this room's space>) — two bound JSON arrays, not
-- one-per-DID, so the statement text and the index walk are unchanged.
(case when author_e.tail in (select value from json_each(?H)) then
        case when author_e.tail in (select value from json_each(?R)) then 2
             else 1 end
      else 0 end) as blocked
```

- `0` — an ordinary row, assembled exactly as today.
- `1` — the §3.1 tombstone: content, name, avatar, reactions, media, link
  embeds and reply/forward context all dropped before decoding, before the
  batch maps are consulted, before `hydrateProfiles`.
- `2` — a **reveal**: the row assembles normally **and** carries
  `blocked: true` (the author is still blocked; the client must keep saying so,
  §4.4). One new optional field on the tombstone path distinguishes the two
  states on the wire, `revealed?: boolean`. Without it a reveal is
  indistinguishable from an ordinary row, and a client that has lost the local
  block set cannot tell that the author it is now rendering is one it blocked.

The room's space DID is already in hand at the `selectMessages` call site,
which matters because clause 2 needs it: `selectMessages` runs against the
*space-scoped* DB (`openSpaceDbForEntity(roomId)`, `getMessages.ts:41-49`), and
the message's `stream_id` is that space's DID — the same value
`materialization/applyBundle.ts` writes into `read_positions.space_did`. So
`revealableBy` is computed by the **caller** and passed in as `?R`, because
the admin edge lives in the space DB that `selectMessages` is already querying
and `selectMessages` does not consult auth at all. Adding an access check
inside it would put the auth layer behind a query layer that every internal
reader (`skipProfileHydration`, the invalidation router, the forward
recursion) also calls.

**What the reveal carries: the full DTO, not the author-suppressed shape.**

The question "does a reveal return content, or the same author-suppressed shape
used elsewhere" is answered by what the reveal is *for*: an admin acting on a
report has to read the message. A shape that suppressed the author — the way a
moderation queue might present a message without its name — cannot be acted on,
because the admin's decision is about *that author*. So `revealed` rows carry
the complete `MessageDto`: content, mime type, author name and avatar,
reactions, media, link embeds, reply context, forward originals. There is no
half-revealed variant; either the tombstone or the message.

**The reveal does not reach the batch queries by accident.** §3.2 excludes
hidden ids from the reaction / embed / link-data batches so a blocked message's
media URLs and enriched link cards never enter the process. A revealed id is
*not* excluded — otherwise the reveal would return a full body with no
reactions, no media and no link previews, which is a silently degraded
message rather than the full one the rule promises. The id list the batches
receive is therefore the page's ids minus the *tombstoned* ids, not minus the
whole hidden set.

**The forward recursion is where the two predicates interact.** A forward row
and its nested original are redacted independently, because they are authored
by different people (§3.2). The rule applies to each on its own terms: a
revealed forward whose *original's* author the admin also blocked is still
revealed throughout, and a tombstoned forward with a revealed original stays
tombstoned — the forwarder's row is the row. The recursion carries both `?H`
and `?R`, so `{ kind: "ids" }` calls made by the recursion are consistent with
the page that spawned them.

**Two properties the rule keeps, worth naming because they are easy to lose.**

- **The reveal is viewer-local.** It changes what one admin receives and
  nothing else: not the materialised row, not another admin's response, not a
  live frame to a different connection. That is the same property that made
  read-time redaction the right design (§3.1) and it is what keeps §7.5's
  reaction-tooltip hiding — which is about *other people's* messages — intact
  for the revealer.
- **The reveal is not an un-block.** The author stays hidden: still no push
  (§3.4), still no unread bump, still tombstoned in every space the admin
  does not administer, still tombstoned in *this* space for a message
  authored before the block was scoped here (§7.12's honest-limit note).

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

**One further field, on the same object:** `revealed?: boolean` (§3.6). It is
present only on a row that is blocked *and* whose content the server has
returned under the admin reveal, and it is what tells a client that a full-
bodied row is a revealed one rather than an ordinary message. A tombstone never
carries it; a row with neither field is ordinary. Two booleans, three states,
and the third state is the one §4.2's render branch and §4.4's affordance need
to exist.

**The field is deliberately direction-blind.** It says "this author is hidden
from you", never which of the two directions produced that (§3.5). A mutual
block is two different product states — you blocked them, they blocked you —
and a single boolean cannot tell them apart; if the UI ever needs to, the
client asks `space.roomy.user.getBlocks` for its own written set and treats a
hidden author *absent* from it as the reverse case. That keeps the wire schema
one field and keeps the server from having to decide what to disclose. The
reveal (§3.6) is the one place the client *does* need the direction, and it
needs it on the client: the affordance's gate is "this is a block I wrote",
which the local block set already answers.

**Nothing here is cached across callers.** The XRPC response cache keys on
`(nsid, params, userDid)` (`cache/queryCacheKey.ts:35-41`) and only these NSIDs
are cacheable at all: `space.getMetadata`, `room.getMetadata`, `getSpaces`,
`space.getThreads`, `space.getActivityFeed` (`cache/index.ts:36-49`). No
message-returning query is in that set, so the reveal cannot be served to
another caller from cache; the per-user component of the key is what would
prevent it if one were added.

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

**The row the reveal renders is a full row.** A `revealed` message is not the
suppressed row with content spliced into it: the suppression listed above
exists to make an indicator out of a row with nothing in it, and a revealed row
has a body, an author, reactions and a media set. So the render branch is on
the pair, not on `blocked` alone:

| `blocked` | `revealed` | Row |
|---|---|---|
| falsy | — | The ordinary row, exactly as today |
| `true` | falsy | Indicator in the avatar slot, no body, no toolbar, no actions |
| `true` | `true` | The ordinary row, plus the "blocked" marker §4.4 specifies |

The middle row is §3.1's tombstone and the bottom row is §3.6's reveal; the
only difference between them on the client is which of the two the server
sent. A row that renders as an ordinary message while its author is blocked is
the state §4.4's affordance exists to make legible, which is why `revealed`
travels with `blocked` rather than replacing it.

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

**Which of these carry the reveal, once it exists.** The reveal is a per-row
affordance and these are not `MessageBubble` rows, so it has to be decided per
surface rather than inherited:

| Surface | Reveal? | Why |
|---|---|---|
| Room timeline, `getMessage` (a deep link) | **Yes** | These are the surfaces a moderator acts on; the indicator sits on a row with a known id and the space is the one being read |
| `SearchResultsList` | **Yes** | Same row shape, same id, same space; a moderator searching for a report needs the message, and the hit is already a full server-redacted row. Its duplicated reply-preview markup (`:368-412`) gets the same branch |
| `ActivityFeed` | **No** | Previews, one line of context, rendered in a hand-rolled row with no message id on it. A reveal here would be a second implementation of the same control on a surface nobody moderates from; the row links into the room, where the reveal lives |
| `MessageContextReply` | **No** | A reply preview inside another message's body; it is context for a message, not a moderation target |

The rule behind the table: **the affordance belongs where a message id is
rendered as a message.** A preview is not one, and duplicating the control onto
previews would multiply the places that must agree about §3.6's predicate
without adding a way to act on it.

### 4.4 The reveal surface, client-side

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
instant on the blocking device) and refreshed on login by reading the user's
own collections plus `space.roomy.user.getBlocks` — the reverse index §3.5
needs, and the only way a client learns it was blocked while offline. Phase 2
adds that query; `refreshBlocks` (§2.4) is the write-through.

The client layer is explicitly **belt, not guarantee**: it exists to close the
window between a local block and the server's refreshed set, and to survive a
stale cache. It is not the enforcement point and must not be described as one.

**The reveal affordance.** The tombstone row is no longer content-free for
everybody: an admin looking at a row they are permitted to reveal (§3.6) gets a
control on it, and it is the only interactive thing on that row.

- **Where.** In the avatar slot's indicator position, on hover, beside the
  blocked glyph — the slot `MessageBubble` already swaps between an avatar and
  a pending-send spinner (`MessageBubble.svelte:205-233`). One more branch in
  the same `{#if}`, so nothing moves.
- **What it says.** "Show blocked message", phrased as the temporary act it is.
  Not "unblock", which this is not — the author stays blocked, stays
  tombstoned everywhere else, and the next page load hides them again. If §7.13
  lands as the personal setting rather than the per-block record, the label
  becomes "Show in <space name>".
- **When it is absent.** For every viewer who is not an admin of that space,
  and for every admin who did not place the block. This is not only a UX rule:
  the client must not *offer* an affordance the server will not honour, so the
  gate is the same predicate the server evaluates (§3.6) — `isAdmin` is
  already available in `ChatArea` (`ChatArea.svelte:54-55`, via
  `createSpaceMetadataQuery` → `space.getMetadata`, which returns
  `isAdmin: access.isAdmin` at `handlers/space.roomy.space.getMetadata.ts:339`),
  and the client's own block set tells it which of the blocks are its own.
- **What happens on click.** The reveal is a server-side predicate, so the
  control cannot be a pure client-side cache edit: it marks the id as revealed
  in the client's block-set module (so the row renders immediately on the next
  paint) **and** asks the server for the revealed row (`getMessage`, which
  carries the reveal through §3.6). If the server returns a tombstone — a stale
  admin edge, a space the admin has since been removed from — the client drops
  its local reveal mark and leaves the indicator. The server is the arbiter;
  the local mark is optimistic paint, the same shape as a pending send. The
  mark is per-message and per-id, never a per-room mode (§7.16): revealing one
  row must not reveal the next.
- **What a revealed row shows.** The full row, with a "blocked" marker on it
  (§4.2's third row) so the viewer can see that the author they are reading is
  one they blocked, and can reverse it. The reveal must never look like an
  ordinary message: an admin scanning a room should not have to remember which
  rows were blocked.

**The client cannot reveal what the server did not send.** The redaction pass
runs over rows the server already redacted, so there is no cached body for a
tombstone in the common case. The one case where there is: a row cached *before*
the block (§4.4's opening premise). Those rows live in the TanStack cache, and
the client-side pass must hold them to the same rule as the server — a cached
body for a hidden author is rendered as the indicator unless the viewer holds
the reveal permission *for that row*, in which case it renders revealed. That
is what keeps the block instant and the reveal honest without a refetch.

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

One consequence for the reveal: a `did:discord:` author holds no repo, so a
block naming one carries no `revealInSpaces` — the field lives on the *blocker's*
record, not on the blocked party's, so this is fine. The blocker is an ATProto
account and can name the space; a bridged author remains revealable by the admin
who blocked them, on the same terms as any other author. What cannot happen is
the reverse: a bridged author can never be the admin in §3.6 clause 2, because
bridged DIDs hold no member or admin edge (`queries/members.ts:146-152`), so
they never appear in `isAdmin`'s answer.

---

## 6. Phasing

Format and dispatch model follow
`packages/app-lite/docs/plans/progressive-scope-extension.md` (§Rollout
Phases). Each phase is one task, dispatched to one worker as soon as the
previous phase is merged or green, on a stacked branch.

```
next
 └── sorrel/user-blocks-p1      (record + write path, flag off)
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
   (the viewer's own repos) with the 60 s in-memory memo, the negative/error
   backoff, and a detached background refresh mirroring
   `queries/profileStore.ts` and `materialization/profiles.ts`.
4. `hiddenBy(userDid)` (§3.5) — `getBlockedDids(userDid)` unioned with
   `blockedBy(userDid)`, the reverse index over `user_blocks` (rows whose
   `blocked_did` is the viewer). A candidate blocker's set is fetched with the
   same `fetchBlockRecords` and cached under their own `user_did`, so the
   enumeration over the viewer's space-members' repos is a cache warm, not a
   per-request cost.
5. `space.roomy.user.refreshBlocks` procedure (§2.4): SDK arktype schema,
   `PROCEDURE_SCHEMAS` entry, generated lexicon, route in `buildRouter`, prose
   in `packages/docs/.../prose.ts` + regenerated `nsids.generated.json`, and
   an `APPSERVER_RPCS` entry. It invalidates the memo for the writer *and* for
   the block's subject (§3.5).
6. Wire the client: after a successful block/unblock write, fire
   `refreshBlocks` (fire-and-forget).
7. Unit tests: the union of the two collections; an empty repo; a PDS that
   404s the unknown collection; a fetch failure recorded as `status:'error'`
   with backoff; the TTL expiry triggering a refetch; and — the mutual case —
   that `hiddenBy(B)` includes a blocker `A` who holds a block naming `B`,
   without `B`'s own repos containing anything. The PDS call must be
   stubbed — `materialization/profileFetchBounds.test.ts` is the template for
   proving every call site is deadline-bounded.

**Acceptance:** `hiddenBy` returns the correct union — the viewer's own Roomy
and Bluesky blocks plus every recovered reverse block — and no read path is
affected yet.

---

### Phase 3 — Timeline redaction and the indicator

**Base:** `feat/user-blocks-p2`. **Depends on:** Phase 2. **This is the phase
that satisfies the core requirement.**

1. Add `blocked?: boolean` and `revealed?: boolean` to
   `packages/sdk/src/schemas/queries/_message.ts`; regenerate lexicons.
2. `selectMessages`: carry the hidden set into both scopes; add the
   `case when … json_each` flag column to the base SQL (§3.2), renumbering the
   room-scope bind parameters; build the tombstone in the assembly step;
   exclude hidden ids from the reaction / embed / link-data batches; thread the
   hidden set through the forward-original recursion.
3. `queries/userBlocks.ts`: `revealableBy(userDid, spaceId)` (§3.6) — the
   per-block `revealInSpaces` check behind the `isAdmin(db, spaceId, did)` gate
   (`auth/access.ts:124-131`). Wire it into the two `selectMessages` call sites
   that are caller-facing (`getMessages`, `getMessage`) as the `?R` parameter,
   and into the client pull path the reveal affordance uses (§4.4). Empty set
   when the caller is not an admin of that space, so the non-admin path costs
   the memoised access lookup and nothing else.
4. `message.getMessage` picks the behaviour up through `{ kind: "ids" }`; add
   a test that the route returns a tombstone, not the row.
5. `packages/design/`: `MessageBubble` gains `blocked`, renders the indicator
   in the avatar slot and no body (`MessageBubble.svelte:205-233`);
   `icons/index.ts` gains `IconBlocked`.
6. `ChatMessage.svelte` computes and forwards `blocked` (including
   `original.blocked` for forwards) and suppresses the toolbar, reactions and
   actions on a blocked row; a revealed row renders ordinary plus the blocked
   marker (§4.2).
7. Client-side redaction pass over the cached array in `ChatArea` (§4.4), plus
   the block-set module and the reveal affordance (§4.4).
8. Tests: `selectMessages` returns a full-length page with tombstones in place
   and an unchanged `nextCursor`; the tombstone carries no content, media, link
   embeds, reactions or profile fields; a forward of a hidden author's message
   is redacted; `ChatArea.loadOlderMessages` still pages past a fully-hidden
   block of history; and a page with a cursor bound correctly against the
   renumbered room-scope parameters (§3.2). For the reveal: the tombstone opens
   for an admin who placed the block, stays shut for an admin who did not, for
   a non-admin who did, for a block whose `revealInSpaces` omits that space,
   and for every Bluesky-sourced block; a revealed row carries the full DTO
   including reactions, media and link embeds (§3.6); and the reveal is
   viewer-local — a second connection on the same room, and the same admin's
   unread count, are unchanged.

**Acceptance:** with the flag on, a hidden author's messages appear as an
indicator-only row in the room timeline and in `getMessage` — **in both
directions** — and paging past them is uninterrupted. An admin who placed the
block and whose block permits it in that space can open that row and gets the
full message; nobody else can, on any surface.

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
8. Each of these reads is caller-scoped, so each carries §3.6's `?R`
   parameter alongside `?H` — a reveal that worked in the timeline and not in
   search would be a moderator's dead end. `SearchResultsList` carries the
   reveal affordance (§4.3); `ActivityFeed` does not.
9. Tests, one per surface, each asserting that no blocked content, name or
   avatar appears in the response.

**Acceptance:** the §"Every route" checklist is covered end-to-end by a test
per row. The reveal opens the same rows it opens in the timeline — search hits
and reply context included — and opens nothing on the surfaces §7.12 excludes.

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

**Base:** `feat/user-blocks-p3`. **Depends on:** Phase 3. Independent of
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
3. If §7.13 lands as recommended, the block action gains an "allow admins of
   …" control that writes `revealInSpaces` (§1.1), and the list on this page
   shows, per block, which spaces permit a reveal. Off by default, per block
   and per space — the setting is the thing that keeps §7.12's exception in the
   user's hands, so it ships with the feature rather than after it.
4. If §7.14 lands as recommended, the reveal writes its audit row (§7.14).
5. Enable `user-blocks` by default.
6. E2E: seed a block (the seeder already inserts feature flags directly —
   `packages/app-lite/e2e/seed.ts:230-235`), open the room, assert the
   indicator renders in the avatar position and the body is absent; as an admin
   with a permitted block, reveal it and assert the body appears with the
   blocked marker, and that a second non-admin session still sees the
   indicator.

**Acceptance:** the flag is on, blocked users are listed and manageable, each
block's reveal permission is visible and editable, and the E2E suite covers
both the blocked and the revealed rendering.

---

## 7. Decisions

Every question this plan raised is answered: the recommendation was accepted on
each one except 7, which is reversed. The plan states the outcome rather than a
preference, and records an alternative only where a future reader would
otherwise re-propose it.

§7.12–§7.16 were added by the 2026-09-28 revision. §7.12 is decided — an admin
may reveal a block they placed themselves, in a space they administer — and
§7.13–§7.16 are the questions that decision raises and does not settle: the
mechanism behind the exception, the audit of it, its interaction with the
service-DID paths, and whether a reveal is per-message or a mode. Each carries
a recommendation; none of the four blocks dispatch, because §3.6 is complete
without them and each has a stated default.

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
public repos (§3.5). That is an enumeration of the viewer's space-members'
repos, a new `space.roomy.user.getBlocks` query, and a fan-out
invalidation on `refreshBlocks` — all in Phase 2, none of it a new phase or a
new read path. HappyView's `filter = { field = "subject" }` lookup would answer
it in one call but only at Jetstream freshness, which §2.1 already rejected as
a safety property; it is the right optimisation later, not the v1 mechanism.

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
**Decided: yes, for their own blocks, in spaces where they hold admin.** The
rule is §3.6, stated there in full. This is an **exception to §7.7, not a
reversal of it**: mutual redaction stands, and the reveal opens a tombstone for
one principal — the admin who wrote the block — in one scope — a space where
that admin holds the admin edge — and nowhere else.

**Why it is not a widening of the moderation model.** The tree has no
permission system for this to attach to (see §7.13), and the alternative
reading of the same sentence — any admin may reveal any block — is a real
change to what blocking means: it would turn a user's block into something an
admin can override, in spaces the user may have nothing to do with. The
decision taken is the narrower one and is the one the requirement states. It
is worth naming plainly because the two readings are one word apart and only
one of them is a safety feature.

**What it costs, stated plainly.** The reveal is a genuine hole in the
invariant this plan spent §3 building, and it is the *only* one. Everything
that follows from that:

- §3.1's "content is not revealable through any route" is now "…except by the
  admin who blocked the author, in a space they administer, for their own
  block".
- §3.6's third clause — the record carrying a per-block `revealInSpaces` — is
  what keeps the hole user-controlled rather than automatic. Without it, every
  admin who blocks someone silently acquires the power to unmask them, and the
  block becomes advisory. It is recommended as §7.13's answer for that reason,
  and if §7.13 lands the other way the cost is named there.
- The reveal is one click and is not reversible by the author: a user cannot
  tell whether an admin revealed their message, which is why §7.14 is a real
  question and not a formality.

**Honest limit, and it is not small.** The third clause is a field on a record
in the blocker's own repo, which means the *client* decides what goes in it at
block time, and the server has no way to tell a `revealInSpaces` the user
chose from one an admin UI set on their behalf. The reveal is therefore a
client-enforced promise on top of a server-enforced block: the server enforces
"only an admin, only their own block, only here", and the client is what makes
"only if the user opted in" true. That is the same trust shape as the block
itself (§1.2 — the record is public and the client writes it), and it is the
reason the alternative in §7.13 is worth considering at all.

**13. What is the mechanism behind the exception — a per-space setting on the
block, or a role permission?** *(open)*
**Recommendation: the per-space setting on the block record** — a
`revealInSpaces` array of space DIDs on `space.roomy.user.block` (§1.1),
default absent, so the reveal is **off** unless the user names a space, per
block and per space.

The thread that produced this requirement landed on exactly that shape —
*"admins should be able to reveal hidden messages in a space but otherwise
not, or maybe it could be a personal setting… personal setting for the
blocker"* — and it is the only one of the two that is implementable in this
tree today:

| | Per-space setting on the block record | Role permission |
|---|---|---|
| What it attaches to | The block record the user already writes (§1.1) | The `admin` edge, or a new role permission |
| Does the tree support it? | Yes — one more property on a record being added anyway | **No.** Roles exist (`roles`, `member_roles`, `role_rooms`, `schema-space.sql:277-302`) but a role carries only *room* access: `role_rooms.permission` is `check(permission in ('read','readwrite'))` (`:298-300`), written by `space.roomy.role.setRoleRoomPermission`, whose `permission` is `'read' | 'readwrite' | null` (`packages/sdk/src/schema/events/roles.ts:93-97`). There is no moderation permission, and no non-room role capability at all |
| Cost | A property, a UI toggle at block time, and a default-empty that fails closed | A new permission kind across the lexicon, the materialiser, `role_rooms`'s schema and its check constraint, `writeAuth`'s role evaluation, the permissions settings page (`routes/[space]/settings/permissions/+page.svelte`), and the SDK — and it would still be *space*-scoped, which cannot express "this space and not that one" for a block the user placed before either existed |
| Who it protects | The blocker, explicitly, per block | Nobody in particular — it is admin authority, granted by the space |

The role-permission reading ("a permission for moderation purposes") solves a
different problem: it lets a space delegate moderation to a non-admin, which
is a real need and a much larger project. It does not answer *whose* block may
be revealed, and without clause 1 it grants admins power over blocks that are
not theirs — the widening §7.12 rejected.

**What the setting would change if adopted:** `revealableBy` (§3.6) reads the
field per `(blocker, space)` instead of treating every own-block as
revealable. Everything else in §3.6 stands. The default must be empty, so the
feature ships with the reveal off and turns on per block and per space — which
also means Phase 3 can land the enforcement path before the setting exists,
with `revealableBy` returning the empty set.

**14. Is a reveal audited, or attributable to the admin who performed it?**
*(open)*
**Recommendation: yes, and the plan should say so before Phase 3 ships the
affordance.** A reveal is the one action in this design that defeats a
user-visible guarantee, and it is performed by someone with authority over the
space. It is the classic case for an audit trail.

**What a minimal audit is.** There is no audit or moderation table anywhere in
the tree (both schema files were checked; neither contains one), so this is a
new table, and the honest cost is that it is new. The minimum that makes a
reveal attributable:

```sql
-- readstate, schema v12 (or the space DB — see below). One row per reveal.
-- Room-scoped like the message, because a reveal is an act on a message.
create table if not exists block_reveals (
  id          text primary key,        -- ulid
  space_id    text not null,
  room_id     text not null,
  message_id  text not null,
  admin_did   text not null,           -- who revealed
  author_did  text not null,           -- whose message it was
  created_at  integer not null default (unixepoch() * 1000)
) strict;
```

**Three shapes, ranked:**

1. **Record on reveal, in the readstate DB.** The admin's reveal is already an
   explicit action (§4.4 — it is a click, not a passive read), so there is
   exactly one place to write the row. Cheap, and it is the shape that makes
   the feature defensible.
2. **Record nothing, but make the reveal explicit on the client** (which §4.4
   already requires — it is never a silent widening). The weakest defensible
   position, and only if the audit is deliberately deferred.
3. **Record every *read* of a revealed message.** Rejected: it multiplies a
   write onto the hottest read path in the system (`getMessages`) to answer a
   question the reveal action already answers.

**The recommendation is 1**, with the caveat that the row must not leak the
content it is recording — ids only, no body, because the audit table would
otherwise become a second copy of the message the block existed to hide, in a
table with different access rules from the message itself.

**Two things to decide with it, both cheap:** whether the *blocked* user may
learn that a reveal happened (recommendation: no — it re-opens the
confrontation §7.7's consequence was accepted for, without the benefit that
made that acceptable), and whether the audit is ever surfaced in the product
(recommendation: not in v1; it exists to be answerable, not to be browsed).

**15. Do the Discord bridge's service-DID reads interact with the reveal?**
*(open)*
**Recommendation: no change, and the plan should state that the bridge's path
is unaffected in both directions.**

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

**Why neither is affected.** The bridge is not a viewer: it holds no blocks
and is never the *blocker* in §3.6's predicate, so the reveal cannot open
anything for it, and it is not in `hiddenBy` for anyone either. And the
service path is not per-viewer in the first place — it returns raw
events to a service DID, so it bypasses the redaction §3.6 excepts from
*by construction*, exactly as it bypasses the redaction §3.1 added.
That asymmetry is pre-existing, is what §7.6 addresses for `stream:` topics,
and is not changed by the reveal in either direction.

**The one thing the revision does add here:** §3.6's predicate must not be
implemented anywhere near a service identity. `APPSERVER_ADMIN_DIDS` is a
process-wide allowlist and the space admin edge is per-space and per-user; the
two are unrelated, and a check written against the wrong one would grant every
allowlisted service DID the power to unmask every block it holds — which,
since services may hold blocks, is not hypothetical. §3.6's clause 2 is
`isAdmin(db, spaceId, did)` (`auth/access.ts:124-131`), the space-edge check,
and the plan should say so at the call site.

**16. Is a reveal per-message, or a mode the admin turns on?** *(open)*
**Recommendation: per-message, and it is the only shape §3.6 supports.**

The requirement's own phrasing is per-message — *"reveal hidden messages… in a
space"* — and the design follows it: each tombstone is opened by acting on that
row, and §4.4's affordance lives on the row it opens. A mode ("reveal all
blocked messages in this space") is a different feature and would change what
§3.6 has to say:

| | Per-message (recommended) | A sticky mode |
|---|---|---|
| Server shape | Exactly §3.6 as written — `?R` is a property of `(viewer, space)`, and the row still has to pass clause 1 | The same predicate, applied to every row: no server change at all |
| What the client does | Marks one id revealed; the row is re-fetched | Marks the space revealed; every blocked row renders |
| Cost | One click per message a moderator needs to read | One click for all of them — cheaper for a moderator clearing a queue |
| Risk | None beyond §3.6 | The reveal stops being an act and becomes a state: a moderator who turns it on and forgets has effectively unblocked that author in that space, and the *blocker's* own intent (§7.13) is what a mode most easily overrides |
| Reversibility | Automatic — the next page load hides the row again | Needs an explicit "hide again", and until then the block is not in force for that admin |

**The recommendation is per-message**, because the reveal is a deliberate act on
a specific message and the mode's convenience is bought with the property that
makes the exception acceptable: that it is narrow, momentary and attributable
(§7.14). If a mode is wanted later, it is a client-side accumulation of the
per-message reveal — a set of ids rather than a flag — and neither §3.6 nor the
server changes. Recording it that way now is what keeps the option open without
paying for it in v1.

---

## Appendix — if HappyView is nonetheless required

Recorded so the §2.1 decision can be revisited on evidence, and because it is
the obvious eventual home for §3.5's reverse lookup: a `db.query` filtered on
`subject` answers "who blocked this DID" in one call, which is exactly the
`blockedBy(did)` query the v1 member-enumeration stands in for. What it cannot
yet do is answer it *freshly* — Jetstream lag is the same objection §2.1
records. Indexing
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
