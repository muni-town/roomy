# Review: Sharding the Read-State DB Per-Space

**Date:** 2026-09-02
**Status:** Review / recommendation (no code changes)
**Scope:** Evaluate the proposal to shard `data/roomy-readstate.sqlite` per-space
as a mitigation for ongoing appserver performance degradation.

> **Update (2026-09-02):** The two cheap wins in §6 were implemented in
> commit `9da88c20` — (1) `space_did` on `user_thread_activity` (schema v7 +
> backfill migration) so `getSpaceUnreadStats`/`queryActiveThreads` scan
> per-space instead of across all of a user's threads, and (2) the query cache
> extended to `space.getThreads`/`space.getActivityFeed` with the missing
> invalidation coverage added. The per-space read-state shard itself remains
> **not recommended** (see §5.1 replication/data-loss risk).

---

## 1. Executive summary

**Verdict: do not commit to the per-space read-state shard yet.** It is a
costly, risky refactor whose benefit is unproven, and the current evidence
points at other bottlenecks. Before spending 1–3 weeks on it, (a) deploy the
observability that was just added and confirm the read-state worker is actually
the saturated resource, and (b) try two cheap, low-risk changes that capture
most of the plausible benefit:

1. Add a `space_did` column + index to `user_thread_activity` so
   `getSpaceUnreadStats` can query per-space instead of scanning *all* of a
   user's engaged threads across every space.
2. Investigate the embed sweeper — the running instance shows **116M null
   enrichments** and a 25k pending backlog, which is sustained DB write churn
   through the *pool* workers, not the read-state worker.

If metrics do confirm the read-state worker is saturated, the cheapest
parallelization is a read-state **worker pool** (mirroring the space pool) over
the *space-scoped* tables — not a full per-space file split with all its
replication and cross-space-query fallout.

---

## 2. Current architecture (what is already in place)

The read-state DB is **already isolated on its own dedicated worker** (commit
`af3f6501`, "split system worker into dedicated global/readstate/events
workers"). It no longer shares a thread with the global or event-log DBs. The
topology today (`src/db/pool.ts`, `src/db/db.ts`):

| DB | File | Worker | Replicated by Litestream? |
|---|---|---|---|
| Per-space materialised | `data/spaces/<did>.sqlite` | pool of N=4 (hash-routed) | **No** (derived, regenerable) |
| Global | `data/global.sqlite` | dedicated | Yes |
| **Read-state** | `data/roomy-readstate.sqlite` | **dedicated** | **Yes** |
| Event-log | `data/roomy-events.sqlite` | dedicated | Yes |

Two things already mitigate read-state load:

- **Query response cache** (`src/cache/index.ts`): `getSpaces`, `space.getMetadata`
  and `room.getMetadata` — the hottest read-state consumers — are cached
  (TTL 60s, invalidation-driven eviction). `getThreads`/`getActivityFeed` are not.
- **N+1 batching** (commits `f82606ed`, `a705fc4b`, `34a8f38b`, `277cff63`,
  `1353aa54`): the read-state lookups that previously saturated the worker were
  batched into single multi-row queries.

So the read-state worker is already a single, dedicated, partially-cached
resource. Sharding it per-space only helps if that one worker is the bottleneck.

---

## 3. Performance-benefit analysis

### 3.1 The read-state DB is small and read-heavy

The materialised per-space DBs were huge (100k+ events per space) and
write-heavy (materialization round-trips) — that is why sharding *them* paid
off. The read-state DB holds `read_positions`, `user_thread_activity`,
`user_space_membership`, push subscriptions, feature flags, and notification
state. These are tiny tables. The win from splitting them across files is
fundamentally smaller.

### 3.2 Read-state access is user-scoped, not space-scoped

The primary keys are `(user_did, room_id)`, `(user_did, thread_id)`,
`(user_did, space_did)`. A single user's rows span many spaces. Sharding by
space splits one user's data across N files — the *opposite* of the natural
access pattern. The per-space materialised split worked because space data is
naturally partitioned by space; read-state data is not.

### 3.3 The hot cross-space queries get worse or unchanged

- `getSpaces` → `getSpaceUnreadStats` runs once **per joined space**, each
  reading `read_positions` + `user_thread_activity` from the read-state DB.
  With per-space shards it still does N read-state queries (one per space) —
  just to N different files. If the shards land on different workers they
  parallelize; if they collide (hash), they serialize exactly as today.
- `getActivityFeed` (no filter) and `search.messages` read unread counts /
  joined-space DIDs across all of a user's spaces — these become fan-out +
  merge across N read-state shards, adding round-trips and complexity.
- `getSpaceUnreadStats` reads **all** of a user's `user_thread_activity` rows
  (cross-space) then filters by space via the per-space DB. This is the one
  query that would genuinely get *faster* under per-space sharding — but it is
  called once per joined space, so the aggregate `getSpaces` cost is unchanged.

### 3.4 The likely bottleneck is elsewhere

The running instance's `/health/embed` shows `enrichedNull: 116,996,841` and
`pending: 25,822`. The embed sweeper has churned through ~117M null
enrichments (≈5M/day) — each a network fetch plus a `pending_links` delete
through the **pool** workers. If the pool is saturated by embed writes and
materialization, sharding the read-state DB (a separate worker) changes
nothing.

### 3.5 Net estimate

| Scenario | Benefit |
|---|---|
| Read-state worker is the bottleneck, shards spread across workers | Moderate for `getThreads`/`getMetadata`; **none** for `getSpaces`/`getActivityFeed` (still N fan-out) |
| Read-state worker is the bottleneck, shards collide | **None** (serialize as today) |
| Bottleneck is the pool / embed sweeper | **None** (different worker entirely) |
| Query cache extended to `getThreads`/`getActivityFeed` | Reduces read-state load with ~zero risk |

The realistic ceiling is "moderate, conditional on hash distribution and on the
read-state worker actually being saturated" — not the order-of-magnitude win the
materialised split delivered.

---

## 4. Cost analysis

The read-state DB is a **mix** of space-scoped and user-global tables, so a
per-space split is not a clean cut:

- **Space-scoped** (shardable): `read_positions`, `user_thread_activity`,
  `user_room_participation`, `notification_state`, `push_preferences`.
- **User-global** (cannot be per-space): `user_space_membership`,
  `push_subscriptions`, `push_user_default`, `feature_flags`,
  `feature_flag_assignments`.

This forces a **two-tier design**: a global read-state DB (user-global tables)
plus N per-space read-state DBs (space-scoped tables), with routing logic to
dispatch each query to the right file. That is the same shape as the
materialised split but with a smaller payoff.

Concrete work items:

1. **Schema split** — new `schema-readstate-space.sql` + keep a global
   read-state schema. Add `space_did` to `user_thread_activity` (and index it).
2. **Routing** — `openReadStateDb()` becomes `openReadStateDb(spaceDid?)` with
   a global fallback; a read-state worker pool (or per-space files on the
   existing dedicated worker).
3. **Cross-space query rewrite** — `getSpaces`, `getActivityFeed`,
   `getSpaceUnreadCount`, `search.messages` need fan-out + merge.
4. **Migration** — one-time split of the existing read-state DB into per-space
   files (enumerate spaces, copy rows, keep user-global tables in the global
   file).
5. **Test churn** — every test that seeds read-state must seed the per-space
   read-state too.

**Effort estimate: 1–2 weeks** (smaller than the 2.5–4 week materialised split,
but with the replication/data-loss complication below).

---

## 5. Risk analysis

### 5.1 Data loss on volume loss (CRITICAL — the proposal must address this)

The read-state DB is the **persistent source of truth** for unread counts,
push subscriptions, feature flags, and membership intent. It is **not
regenerable** from the event log (unlike the per-space materialised DBs). It is
replicated by Litestream today (`litestream.yml`).

Litestream requires **static `dbs:` entries** — it cannot replicate a dynamic
set of per-space files. Sharding read-state per-space therefore either:

- **Drops replication** for the space-scoped read-state tables (unread counts,
  thread activity, notification state) → a lost `/data` volume loses that
  state permanently, or
- Requires a new replication mechanism for N dynamic files (Litestream doesn't
  support this; you'd need a different tool or a per-space replication loop).

This is the single biggest risk and is unique to the read-state DB — the
materialised per-space split was safe precisely because those DBs are derived
and self-rebuild.

### 5.2 Cross-space query correctness

`getSpaces`, `getActivityFeed`, `getSpaceUnreadCount`, and `search.messages`
must return byte-identical results whether a user's spaces land on one shard or
spread across N. This needs dedicated equivalence testing (N=1 vs N=4 diff).

### 5.3 Hash-collision / distribution

If a user's spaces hash to the same read-state worker, the fan-out serializes
and the benefit vanishes. Needs a realistic-DID distribution check before ship.

### 5.4 Migration correctness

Splitting the existing read-state DB must not drop or duplicate rows, and must
handle the user-global tables correctly. A botched migration silently corrupts
unread counts / push state.

### 5.5 Operational complexity

More files, more workers, more routing. The `/health/pool` observability that
would tell you whether the pool is spreading load was only just added — it is
not yet proven in production.

---

## 6. Cheaper alternatives to try first

1. **Add `space_did` to `user_thread_activity`** (small migration, ~1 day).
   `getSpaceUnreadStats` currently scans *all* of a user's engaged threads
   across every space, then filters by space via the per-space DB. A
   `space_did` column + `(user_did, space_did)` index turns that into a
   per-space indexed lookup. This captures the one concrete read-state win the
   shard would deliver, without any sharding.

2. **Extend the query cache to `getThreads` and `getActivityFeed`.** These are
   the hot read-state consumers not yet cached. If their responses are fully
   covered by `inferSignals` invalidation (the same bar the existing three
   cacheable NSIDs meet), this removes a large share of read-state load with
   near-zero risk.

3. **Investigate the embed sweeper.** 116M null enrichments is a red flag. If
   the pool workers are saturated by embed writes, that is the real bottleneck
   and it is far cheaper to fix (cap the sweeper, dedupe/backfill the
   `pending_links` backlog, or stop re-enriching URLs that already resolved to
   null) than to shard read-state.

4. **If the read-state worker is genuinely saturated:** give the *space-scoped*
   read-state tables a worker pool (mirroring the space pool) rather than a
   full per-space file split. Same parallelism, no replication loss, no
   cross-space fan-out rewrite.

---

## 7. Recommendation

1. **Deploy the observability first** (`/metrics`, `/health/pool` — commits
   `d2e64d24`, `af3f6501`). Confirm from `roomy_pool_worker_pending` and
   per-endpoint latency that the read-state worker is the saturated resource.
   If it is not, the shard is wasted effort.
2. **Do the two cheap wins** (items 1–2 above) and re-measure.
3. **Investigate the embed sweeper** (item 3) — it is a plausible root cause
   that the read-state shard would not fix.
4. **Only then** revisit the read-state shard, and if you do, prefer the
   worker-pool-over-space-scoped-tables variant (item 4) over a full per-space
   file split, because the file split's replication/data-loss risk (§5.1) is
   not worth the marginal benefit.
