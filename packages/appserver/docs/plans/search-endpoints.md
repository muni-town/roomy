# Search Endpoints — Qdrant vs SQLite FTS

**Date:** 2026-08-11
**Status:** Messages and rooms search shipped. `space.roomy.search.messages`
and `space.roomy.search.rooms` are registered in the appserver
(`handlers/space.roomy.search.messages.ts`), built on Qdrant with the config
singleton and no-op fallback §"Qdrant client in Bun" describes (the endpoint
returns 503 when `QDRANT_URL` is unset). The semantic/vector endpoint and the
members/threads name search are not built; the plan's recommendations for those
stand.
**Parent doc:** `appserver-architecture.md`
**Related:** `xrpc-interface-spec.md`, `query-response-cache-plan.md`, `per-space-dbs.md`

## Purpose

Design the search surface for the Roomy appserver: which endpoints to add, which
use cases belong on **SQLite FTS5** vs **Qdrant** (vector/semantic), and how to
handle the cross-space fan-out problem for full-text message search.

This document records the design and what shipped. It answers the questions in the
task: *how would we integrate Qdrant, which use cases make sense to go to it vs
SQLite search, and is cross-space full-text message search feasible given the
fan-out?*

---

## TL;DR — recommendation

| Use case | Engine | Why |
|---|---|---|
| **Members search** (typeahead) | SQLite FTS5 (or the existing `LIKE`) | Small, per-space, prefix/substring, already exists |
| **Threads search** (by name) | SQLite FTS5 | Small, per-space, exact-ish, low volume |
| **Spaces search** (by name) | SQLite FTS5 | Small, per-user, low volume |
| **Rooms/channels search** (by name) | SQLite FTS5 | Small, per-space |
| **Message full-text search** (per-space) | SQLite FTS5 | Bounded corpus, per-space DB already exists |
| **Message full-text search** (cross-space, "all my spaces") | **Qdrant** (or a global FTS index) | Fan-out problem; needs a global index |
| **Semantic / vector search** (messages, "find the message about X") | **Qdrant** | Embeddings; SQLite can't do this |

**Rule of thumb:** if the corpus is *bounded by a single per-space DB* and the
query is *name/prefix/substring*, use SQLite FTS5 — it's free, transactional
with the materialised views, and already co-located. If the corpus is *global /
cross-space* or the query is *semantic*, use Qdrant.

---

## Current state (what we're building on)

- **Per-space SQLite DBs** (`data/spaces/<spaceDid>.sqlite`), one per space,
  holding `entities`, `edges`, `comp_content` (message blobs), `comp_room`
  (label/name via `comp_info`), `comp_user`, `comp_info`, `activity_item`, etc.
- **Global DB** (`data/global.sqlite`): `profiles`, `entity_space` (entity →
  space index), `pending_links`, and `joinedSpace`/`leftSpace` membership edges.
- **Message content** is a blob in `comp_content.data` with a `mime_type`
  (`text/markdown` legacy, `application/vnd.roomy.richtext+json` new). Decoded
  via `decodeContent` / `decodeRichTextBody` (`src/db/content.ts`).
- **Existing search-ish surface:** `space.getMembers` already takes a `search`
  param (case-insensitive `LIKE` on handle/name/DID) for the mention typeahead.
- **Auth model:** per-space membership/admin orthogonal; per-room read access is
  the union of admin edge, channel `default_access`, and role grants. **Every
  search result must be filtered by the caller's read access.**
- **Deployment:** single Bun process on Railway, SQLite under `/data` with
  Litestream replication. Qdrant would be a **separate service** (Railway
  plugin or self-hosted), not in the appserver container.

---

## Proposed XRPC endpoints

All are **queries** (GET), authenticated, with caller-scoped read-access
filtering. Namespaced under `space.roomy.search.*`.

| NSID | Scope | Params | Returns |
|---|---|---|---|
| `space.roomy.search.members` | per-space | `spaceId, q, limit, cursor` | members (reuse `selectMembers`) |
| `space.roomy.search.threads` | per-space | `spaceId, q, limit, cursor` | threads (name + latest activity) |
| `space.roomy.search.spaces` | per-user | `q, limit, cursor` | spaces caller is member/admin of |
| `space.roomy.search.rooms` | per-space | `spaceId, q, limit, cursor` | channels/rooms by name |
| `space.roomy.search.messages` | per-space **or** cross-space | `spaceId?, q, limit, cursor` | messages with room/thread context |
| `space.roomy.search.semantic` | cross-space (Qdrant) | `q, limit, cursor` | messages by vector similarity |

`space.roomy.search.messages` is the interesting one. Two modes:

1. **`spaceId` provided** → SQLite FTS5 on that space's DB. Bounded, fast.
2. **`spaceId` omitted** → cross-space search across all spaces the caller can
   read. This is where the fan-out problem lives (see below).

---

## SQLite FTS5 — the per-space workhorse

### Why FTS5 fits the per-space cases

- **Co-located & transactional.** FTS5 virtual tables live in the same SQLite
  file as the materialised views. The materialiser already writes
  `comp_content`; we add an FTS5 table and populate it in the same transaction
  (or via triggers). No new service, no network hop, no consistency window.
- **Fast enough.** FTS5 is a real inverted index. For a single space's message
  corpus (thousands to low-millions of rows) prefix/substring and phrase
  queries are sub-millisecond to low-ms. Per-character typeahead on members and
  thread names is trivially fast.
- **Zero new infra.** No Docker service, no Railway plugin, no API key, no
  embedding model. Fits the "transitional Bun appserver" reality.

### Schema sketch

```sql
-- Per-space DB. External-content FTS5 table over comp_content.
create virtual table if not exists message_fts using fts5(
  content,            -- indexed text
  content='comp_content',  -- external content table
  content_rowid='rowid'    -- comp_content has no rowid; see note
);
```

`comp_content` has a text PK (`entity`), not an integer rowid, so FTS5's
external-content mode needs a rowid. Two options:

- **Option A (simplest):** a dedicated FTS5 table with its own rowid, populated
  by the materialiser alongside `comp_content` (denormalised copy of the
  decoded text). Slight duplication, but trivial and robust.
- **Option B:** add an integer `rowid` alias to `comp_content` and use
  external-content mode. Cleaner, but touches the schema + materialiser.

**Recommendation: Option A** for v1 — a `message_fts` table holding
`(entity, room, author_did, content, timestamp)` with a `content` column
indexed by FTS5 and the rest as regular columns for filtering/ranking. Populate
it in the materialiser's `createMessage`/`editMessage` path (decode the blob to
plain text first — strip richtext blocks to text). This keeps the FTS index
transactionally consistent with the materialised views.

### Query sketch

```sql
select m.entity, m.room, m.author_did, m.timestamp,
       snippet(message_fts, 0, '[', ']', '…', 12) as snippet,
       bm25(message_fts) as rank
from message_fts m
where message_fts match :q
  and m.room in (/* rooms caller can read */)
order by rank
limit :limit;
```

**Read-access filtering is the hard part.** FTS5 can't join to `edges`/`roles`
for access control. Two approaches:

1. **Pre-filter by room set.** Resolve the caller's readable room IDs first
   (reuse `roomAccess` / the access memo), then `m.room in (...)` in the FTS
   query. Correct, but the room set can be large.
2. **Post-filter.** Run FTS, then drop results the caller can't read. Fine for
   small result sets, wasteful for large ones.

**Recommendation:** pre-filter by room set for per-space search (the room set
is bounded by the space), and rely on the access memo already used by
`getThreads`/`getMessages`. For cross-space, see below.

### Threads / members / spaces / rooms search

These are all small, per-space (or per-user) name/prefix searches. FTS5 works,
but honestly the existing `LIKE '%q%'` on `comp_info.name` / `comp_user.handle`
is often enough at this scale. FTS5 earns its keep when you want:
- prefix matching with ranking (`name MATCH 'foo*'`),
- case-insensitivity + diacritic folding,
- substring across multiple fields in one index.

**Recommendation:** start with FTS5 for **messages** (the only corpus that
grows unboundedly) and keep `LIKE` for members/threads/spaces/rooms until a
measured need appears. Don't over-engineer the small cases.

---

## Qdrant — the cross-space & semantic engine

### Why Qdrant (and not SQLite) for these cases

1. **Cross-space message search has a fan-out problem.** "Search all messages
   across every space I'm in" means querying N per-space DBs. With SQLite FTS5
   you'd either (a) fan out to N DBs and merge — N queries, N× latency, and
   N grows with the user's space count — or (b) build a **global FTS index** in
   the global DB. Option (b) is actually viable (see below), but it's a global
   denormalised index that duplicates content across spaces, which is exactly
   the kind of thing a dedicated search service is designed for.
2. **Semantic / vector search is impossible in SQLite.** "Find the message
   that's *about* X" (not containing X) needs embeddings + ANN. SQLite has no
   vector index. Qdrant does HNSW ANN natively.
3. **Qdrant is a real search service.** Payload filtering (by space, room,
   author, timestamp), hybrid search (dense + sparse/BM25), and it's designed
   to be the global index. It's the natural home for a cross-space index.

### How we'd integrate Qdrant

- **Deployment:** a separate Qdrant service (Railway plugin or self-hosted
  container). The appserver talks to it over HTTP (REST) or gRPC. Add
  `QDRANT_URL` (+ optional `QDRANT_API_KEY`) to the appserver env, mirroring
  how `HAPPYVIEW_ENDPOINT` is handled (`src/happyview.ts` is a good template
  for a config-singleton + client module).
- **Collections:** one collection per entity type, or one collection with a
  `type` payload field. For messages:
  - **Payload:** `{ spaceDid, roomId, threadId, authorDid, timestamp, content }`
  - **Vector:** embedding of the message text (see embedding model below).
  - **Sparse vector (optional):** BM25-style sparse vector for hybrid
    full-text + semantic ranking.
- **Indexing path:** the materialiser (or a dedicated indexer) upserts a point
  per message on `createMessage`/`editMessage`, deletes on delete. This is
  **async / out-of-band** from the SQLite transaction — Qdrant is eventually
  consistent with the materialised views. That's fine for search (search is
  never the source of truth), but it means a just-sent message may not appear
  in search for a beat. Acceptable.
- **Query path:** embed the query text, call Qdrant `search` with a payload
  filter for the caller's readable spaces/rooms, get back point IDs, then
  hydrate full message DTOs from the per-space DBs via `selectMessages`
  (`{ kind: "ids" }` scope already exists!). This is the key integration win:
  **Qdrant returns IDs, SQLite hydrates the payload** — no need to store full
  message bodies in Qdrant.

### Embedding model

- **Hosted:** OpenAI `text-embedding-3-small` (1536 dims) or `text-embedding-3-large`
  (3072). Simple, good quality, but a per-request cost + external dependency.
- **Local:** a small ONNX model (e.g. `all-MiniLM-L6-v2`, 384 dims) run in the
  appserver or a sidecar. No external cost, but adds CPU and a model-download
  step. For a chat app, 384-dim MiniLM is often "good enough" for semantic
  message search.
- **Recommendation:** start with a hosted embedding API behind a feature flag
  (so it's off by default and doesn't block the FTS5 work), and treat the
  embedding provider as a pluggable interface. Qdrant doesn't care which model
  you use — it just stores whatever vector you give it.

### Qdrant client in Bun

Qdrant has a REST API and an official TypeScript client (`@qdrant/js-client-rest`).
Bun can use it directly. Keep it behind a config singleton (`src/qdrant.ts`)
with a no-op fallback when `QDRANT_URL` is unset, so the appserver runs fine
without Qdrant (FTS5-only mode).

---

## The cross-space fan-out problem (the crux)

The task asks: *is full-text message search across all spaces a user is in
feasible? We get a bit of a fan-out issue, especially with real-time /
per-character.*

### The fan-out, concretely

"Search all messages in all my spaces" = the union of N per-space corpora. The
naive approach fans out to N per-space DBs:

```
for each space S in caller's spaces:
    results += FTS5(S, q)   // one query per space
merge + rank + filter by read access
```

Cost scales with **N (number of spaces)** and each query is a separate DB open
+ FTS scan. For per-character typeahead this is too slow once N is non-trivial
(10+ spaces), and it's wasteful (most spaces won't match).

### Options

**Option 1 — Global FTS index in the global DB (no Qdrant).**
Add a `message_fts_global` table to `data/global.sqlite` (or a dedicated
`search.sqlite`), populated by the materialiser for every space. Query it once
with a payload filter on `spaceDid IN (caller's readable spaces)`. This kills
the fan-out: **one query, one index, N filtered by a payload column.**

- Pros: no new service; transactional-ish; reuses the existing global DB.
- Cons: global DB grows with all message content (denormalised); the global DB
  is currently small (profiles + membership) and is **replicated by Litestream**
  — adding all message text makes it big and churns replication. Also the
  global DB is "derived/regenerable" but currently only holds cross-space
  state; stuffing message content in it muddies that boundary.

**Option 2 — Qdrant as the global index (recommended).**
Qdrant *is* the global index. One collection, payload-filtered by
`spaceDid IN (caller's readable spaces)`. No fan-out — Qdrant does the
filtered ANN/BM25 in one call. This is exactly the use case Qdrant is built
for.

- Pros: no fan-out; hybrid full-text + semantic in one place; scales
  horizontally; payload filtering is native.
- Cons: new service; eventual consistency; needs an embedding model for the
  vector half (though Qdrant also supports **sparse vectors / BM25** for pure
  full-text without embeddings — see below).

**Option 3 — Per-space FTS5 + client-side fan-out (reject).**
Query N DBs and merge. Rejected: N× latency, N DB opens per keystroke, and the
read-access merge is complex. Only acceptable for a *single* space.

### Recommendation

- **Per-space search** (the common case: user is in one space, searching it):
  SQLite FTS5. Fast, free, transactional.
- **Cross-space search** (the "search everything" case): **Qdrant**, with a
  payload filter on the caller's readable spaces. This is the only clean answer
  to the fan-out.
- **Real-time / per-character:** don't do full-text search in real time. Two
  mitigations:
  1. **Debounce + minimum query length.** Standard: only fire a search after
     ~200–300ms of no typing and ≥2–3 chars. This is a client concern
     (TanStack Query already dedupes/debounces).
  2. **Two-tier latency.** For per-character *typeahead* (members, thread
     names, spaces) use the fast SQLite path. For full-text *message* search,
     use the debounced, ≥3-char path. Don't run FTS/ANN per keystroke.

  The "we maybe don't want full-text search in real time" instinct is correct:
  full-text message search is a *submitted* query, not a typeahead. Typeahead
  is for names (members/threads/spaces), which are small and fast.

### Qdrant full-text without embeddings?

Qdrant supports **sparse vectors** (BM25-style) via its `sparse` vector type
and the `fastembed`/`bm25` sparse encoders. This means you can use Qdrant for
**pure full-text cross-space search without any embedding model** — index a
sparse BM25 vector per message, query with the same. That's a nice middle
ground: Qdrant solves the fan-out for full-text *and* gives you semantic search
later, with one service. Worth evaluating in the spike.

---

## Read-access filtering (all engines)

Every search result must be filtered by the caller's read access. The auth
model (admin ⊥ membership, per-room `default_access` + role grants) means a
search can't just filter by "is member of space" — it must filter by **per-room
read access** for messages/threads.

- **Per-space FTS5:** pre-filter by the caller's readable room set (reuse the
  access memo from `getThreads`/`getMessages`).
- **Qdrant:** store `roomId` in the payload and filter by the readable room
  set, OR store a coarse `spaceDid` filter and post-filter by room. For v1,
  filter by readable **space** set in Qdrant (cheap, coarse) and post-filter
  the hydrated results by room access (the result set is small, top-K).
- **Never cache search results across users** — they're caller-scoped. The
  existing query-response-cache plan keys by `(nsid, params, callerDid)`, which
  is correct for search too, but search results are usually too dynamic to
  cache server-side. Rely on the client TanStack cache + debounce instead.

---

## Indexing / consistency

- **SQLite FTS5:** populate in the materialiser transaction (or a trigger on
  `comp_content`). Transactionally consistent with the materialised views.
  Rebuildable by re-materialisation (FTS5 table is derived data, like the rest
  of the per-space DB).
- **Qdrant:** async upsert from the materialiser (fire-and-forget or a small
  queue). Eventually consistent. On boot, a backfill sweeper can re-index
  messages that are missing (compare against a cursor, like the embed
  enricher's `pending_links` pattern). Qdrant is derived data — safe to rebuild.

---

## Migration / rollout

1. **Phase 1 (no new infra):** SQLite FTS5 for per-space message search +
   `search.messages` (space-scoped). Add `search.members`/`threads`/`spaces`/
   `rooms` (mostly thin wrappers over existing queries). Ship, measure.
2. **Phase 2 (spike):** stand up a Qdrant instance, index a space's messages
   with sparse BM25 vectors, benchmark cross-space full-text latency vs the
   global-FTS alternative. Decide: Qdrant-sparse vs global-FTS for cross-space
   full-text.
3. **Phase 3 (semantic):** add embeddings (hosted or local), enable
   `search.semantic` behind a feature flag. Qdrant already in place from
   Phase 2.

---

## Open questions / to test

- **FTS5 vs LIKE for members/threads/spaces/rooms:** measure. At current scale
  `LIKE` is probably fine; FTS5 wins on ranking + multi-field.
- **Global FTS index vs Qdrant-sparse for cross-space full-text:** the real
  decision. Global FTS is simpler (no service) but bloats the replicated global
  DB. Qdrant-sparse is a service but is the natural long-term home and unlocks
  semantic later. **Recommend a spike that benchmarks both.**
- **Embedding model choice** (hosted vs local) — only matters for Phase 3.
- **How fast is FTS5 on a large space?** Need a benchmark with realistic
  message counts (100k–1M) to confirm the per-space path stays sub-10ms.
- **Qdrant payload filter cardinality:** filtering by a large readable-room
  set — does it stay fast? (Qdrant recommends payload indexes on filter
  fields; `spaceDid` + `roomId` should be indexed.)

---

## Summary

- **SQLite FTS5** for everything per-space and name/prefix: members, threads,
  spaces, rooms, and per-space message search. Free, transactional, co-located.
- **Qdrant** for cross-space message search (solves the fan-out with a single
  filtered query) and for semantic/vector search (impossible in SQLite).
- **Don't do full-text search per keystroke.** Typeahead = names (fast, SQLite);
  full-text message search = debounced, ≥3 chars, submitted query.
- **Qdrant returns IDs, SQLite hydrates** — reuse `selectMessages({kind:"ids"})`.
- **Read-access filtering is mandatory** and caller-scoped; never cache search
  across users.
