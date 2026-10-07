# Per-space query-planner statistics

Each per-space DB carries its own `sqlite_stat1`. Without it SQLite costs
indexes by fixed defaults, and for an equality lookup it prices the
single-column index it happens to walk (`idx_entities_stream_room`) below the
table's rowid index — so a point lookup becomes a scan of the space's entire
`stream_id` partition.

Statistics are refreshed in three places, all of them `PRAGMA optimize`:

| where | covers | cadence |
|---|---|---|
| `openSpaceDb` (worker) | the DB being opened, before it serves a request | once per open |
| LRU eviction (worker) | the handle being closed | per eviction |
| `reMaterializeFromLocalEvents` (boot) | every stream, caught up or not | per boot |

The open-time refresh is what makes the guarantee hold for a space created or
first-visited after the boot sweep has already passed it. The boot sweep is
what re-measures growth for every space on each deploy, and the eviction
refresh is the bound for a handle that stays open and keeps taking writes.

## Why the boot sweep alone was not enough

The sweep visits every stream that has events, so it covers every space that
existed when the process started. A space created mid-uptime, or whose DB file
is first opened after the sweep passes, had no statistics until the next
restart — and the mis-plan is not confined to large spaces. Measured on DBs
built from the real `schema-space.sql`, `select id from entities where id in
(?, …) and stream_id = ?` with eight ids:

| entities | with statistics | without |
|---|---|---|
| 500 | 0.008 ms *(id index)* | 0.155 ms *(stream_id scan)* |
| 5 000 | 0.005 ms | 1.491 ms |
| 20 000 | 0.007 ms | 28.055 ms |
| 131 000 | 0.006 ms | 323.483 ms |

The plan flips at the smallest size measured. `PRAGMA optimize` on that 131k
DB costs 25–100 ms the first time (nothing to measure yet) and ~0.1 ms once the
statistics are current, so analyzing on open is close to free after the first
time each file is seen.

## Why the shape is what matters

Three query shapes reach `entities` by a point lookup and are mis-planned
without statistics. Measured on a 131k-entity DB with none:

| query | before | after | plan |
|---|---|---|---|
| `readPositions` engaged-thread ownership (`id in (…) and stream_id = ?`, 8 ids) | 226 ms | 0.012 ms | `idx_entities_stream_room` → `sqlite_autoindex_entities_1` |
| `userActiveThreads` existing-count (`count(*) … id in (…) and stream_id = ?`) | 237 ms | 0.006 ms | same |
| `userActiveThreads` lazy-backfill candidates (`author_e.tail = ? and e.stream_id = ?`) | 411 ms | 0.062 ms | same |

The `roomAccessProjection` `all_in_payload` upsert reads a space's rooms with
`where e.stream_id = ?` and no `id` predicate; it scans the whole partition
before and after (197 ms on the fixture, plan unchanged). That is the correct
plan — the query genuinely wants every room in the space — and it is the reason
statistics are not applied as a blanket re-plan.

A space's DB is served by exactly one pool worker, so one partition scan for a
handful of ids delays every other request queued behind it on that worker: the
tail latency shows up on an unrelated route that merely shares a worker index.

## Cost

`PRAGMA optimize` re-analyzes only what its heuristics call stale. On a 131k
entity space DB the first analyze takes 25–100 ms (no statistics present yet);
every later call on the same file takes ~0.01 ms. The shared DBs took 43 ms
(global, 295k `entity_space` rows), 55 ms (events, 436k rows) and 3 ms
(read-state) on their first pass.

Statistics live in the DB file, so they persist. Every refresh is wrapped so a
failure leaves the previous plan in place and the boot continues rather than
failing the sweep.

## What is deliberately not forced

Two query shapes reach the `edges` table by `(label, head)` rather than by
`entities.id`, and their plans are decided by statistics rather than by the
index set:

- `resolveReplyToAuthors` (`mentions.ts`) joins `reply` edges to the replied-to
  message's `author` edge. Its `author_e.label` predicate carries a unary `+`,
  which stops SQLite from using an index on that column. That pins the join to
  the correlated `(head=?)` lookup instead: unforced, the planner may drive
  from `idx_edges_label_tail (label='author')`, whose tail is a *user* DID —
  matching every message that user ever wrote and seeking each one in `reply_e`
  for a reply edge. Measured at 20.6 ms for one reply id and 76 ms for eight,
  against 0.002 ms for the correlated form. Both label predicates stay, and each
  guards a different edge that shares a message's `head`: `reply_e.label` keeps
  a `forward` edge's target out (forward edges also start at the message), and
  `author_e.label` keeps a message's own `reply` edge out (it shares the `head`
  the join walks). Neither is defensible by a test through this function — the
  result is a Map keyed by `message_id`, so an extra row overwrites the correct
  one instead of failing an assertion.

- The `stream_id` predicates on the `entities` lookups are load-bearing. The
  per-space DB is not exclusively written by its own stream's materialiser:
  `embed/enricher.ts` inserts link entities with `stream_id = ''`, and
  `joinedSpaces.ts` seeds user/space entity rows under their own DID. A
  lookup whose bound value matched one of those rows would return a foreign
  row without the predicate. Keeping the predicate and supplying statistics is
  therefore the correct pairing; removing it would trade a plan for a
  correctness hazard.
