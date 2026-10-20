/**
 * The block set — who a viewer must not see.
 *
 * Two lookups whose union is the answer, because **a block hides both ways**:
 *
 *   1. `blocks(did)` — the blocks `did` wrote into their own repos, from
 *      `space.roomy.user.block` and `app.bsky.graph.block`.
 *   2. `blockedBy(did)` — everyone whose repo holds a block naming `did`. The
 *      blocked party has no record of their own saying they were blocked, so
 *      the fact only exists in the *blocker's* repo. That is what makes this a
 *      reverse index the appserver has to build rather than look up.
 *
 * `hiddenBy(viewer)` is the union, and it is the only thing any read path
 * needs: a filter never has to ask *who* blocked, only whether this author is
 * hidden from this viewer, so every downstream consumer is direction-agnostic
 * and the mutual case costs no branching anywhere.
 *
 * ## Who starts a fetch
 *
 * The DID the set describes, once that DID authenticates ({@link warmBlockSet}).
 * The record naming a blocked account lives in the blocker's own repo, so a row
 * answering `blockedBy` is written by a fetch keyed on the *blocker* — the same
 * `user_blocks` shape as their forward set, keyed by their own `user_did`. One
 * table, two directions, and the set of repos the appserver reads is the set of
 * accounts that actually use it.
 *
 * ## Why a read never fetches
 *
 * Every read path in the appserver consumes this set, `room.getMessages`
 * included. A PDS round-trip inside a read would make a message list as slow as
 * its slowest member's PDS, so a read serves the indexed rows it already has
 * and nothing else — no DID resolution, no `listRecords`, nothing awaited.
 * Refreshing is the account's own business, and the stamp of the last attempt
 * keeps it to one PDS read per cache window however many requests it makes. The
 * same detach-and-hydrate shape as `profileStore`, down to the in-flight map
 * that collapses N concurrent requests for one DID into a single fetch.
 *
 * The staleness this accepts: a block written where the appserver cannot see it
 * — a Bluesky client, say — is enforced from the blocker's next authenticated
 * request rather than at a fixed deadline. A block written *in* Roomy is exact,
 * because the client's `space.roomy.user.refreshBlocks` call refreshes the
 * writer in the same breath as the write.
 */

import type { UserDid } from "@roomy-space/sdk";
import {
  fetchBlockRecords,
  type BlockRecord,
} from "../materialization/blocks.ts";
import { tryOpenReadStateDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { log } from "../log.ts";

/**
 * How long a refreshed block set is trusted for: the window a read serves the
 * rows it has, and the least time between two reads of one account's repos.
 *
 * Read per call so a test can drive a short window and observe a refetch, the
 * same seam `profileFetchTimeoutMs` provides for the profile deadline.
 */
function blockCacheTtlMs(): number {
  const raw = Number(process.env.BLOCK_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

/**
 * How long a failed fetch is left alone. A block lives in the user's own PDS,
 * so a failure is transient (a slow or briefly-down host); retrying it on every
 * request would turn one unreadable PDS into a fetch per request, and this is
 * short enough that a recovered host is picked up within the minute.
 */
function blockErrorBackoffMs(): number {
  const raw = Number(process.env.BLOCK_ERROR_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_ERROR_BACKOFF_MS;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_ERROR_BACKOFF_MS = 60_000;

/** The shared empty answer, so an anonymous caller allocates nothing. */
const NO_DIDS: ReadonlySet<string> = new Set<string>();

/**
 * Refreshes in flight, one per account. Keyed by DID so N requests from one
 * account collapse into one refresh; the entry is the whole chain (decide,
 * then fetch), so a test can await it from the moment it is registered.
 */
const inflightFetches = new Map<string, Promise<void>>();

interface CacheEntry {
  /** Author DIDs the memoised user must not see. */
  dids: Set<string>;
  /** When the rows behind this answer were read from the read-state DB. */
  readAt: number;
}

/** The blocks a user *wrote*; keyed by that user's DID. */
const writtenCache = new Map<string, CacheEntry>();

/**
 * The recovered blockers of a user. Keyed by the blocked user's DID. Separate
 * from {@link writtenCache} because the two are different questions over the
 * same table, and a fetch for one does not answer the other.
 */
const reverseCache = new Map<string, CacheEntry>();

// ─── Test helpers ─────────────────────────────────────────────────────────

/** Clear every memo. Mirrors `_resetProfileStoreCache`. */
export function _resetBlockCaches(): void {
  writtenCache.clear();
  reverseCache.clear();
  inflightFetches.clear();
}

/** The refreshes currently in flight, so a test can await them. */
export function _blockRefreshesInFlight(): Promise<void>[] {
  return [...new Set(inflightFetches.values())];
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * The blocks `userDid` wrote into their own repos.
 *
 * The memoised set when it is fresh, else the indexed rows, else the empty set.
 * Never fails the caller: throwing here would fail the message list the set
 * exists to filter.
 */
export async function blocks(userDid: string): Promise<ReadonlySet<string>> {
  const cached = writtenCache.get(userDid);
  if (cached && Date.now() - cached.readAt < blockCacheTtlMs()) {
    return cached.dids;
  }

  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return cached?.dids ?? NO_DIDS;

  const rows = await readStateDb
    .query("select blocked_did from user_blocks where user_did = ?")
    .all<{ blocked_did: string }>([userDid]);
  const entry: CacheEntry = {
    dids: new Set(rows.map((r) => r.blocked_did)),
    readAt: Date.now(),
  };
  writtenCache.set(userDid, entry);
  return entry.dids;
}

/**
 * Everyone whose repos hold a block naming `userDid` — the recovered reverse
 * direction.
 *
 * A plain indexed read (`idx_user_blocks_blocked`): the reverse fact is *stored*
 * here once the blocker's repo has been read, so answering needs no network at
 * all. What populates those rows is {@link warmBlockSet}, run for the blocker.
 */
export async function blockedBy(userDid: string): Promise<ReadonlySet<string>> {
  const cached = reverseCache.get(userDid);
  if (cached && Date.now() - cached.readAt < blockCacheTtlMs()) {
    return cached.dids;
  }

  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return cached?.dids ?? NO_DIDS;

  const rows = await readStateDb
    .query("select user_did from user_blocks where blocked_did = ?")
    .all<{ user_did: string }>([userDid]);
  const entry: CacheEntry = {
    dids: new Set(rows.map((r) => r.user_did)),
    readAt: Date.now(),
  };
  reverseCache.set(userDid, entry);
  return entry.dids;
}

/**
 * The author DIDs a viewer must not see: their own blocks, plus everyone who
 * blocks them.
 *
 * `viewerDid === null` is an anonymous caller, who hides nobody and is hidden
 * from nobody — the empty set, with no DB read and no fetch.
 *
 * Both halves are answered from `user_blocks` alone, so this is as fresh as the
 * last fetch of the DID each half belongs to and never a network call: the
 * viewer's own set is refreshed by the viewer ({@link warmBlockSet}), a
 * blocker's by the blocker.
 */
export async function hiddenBy(
  viewerDid: string | null,
): Promise<ReadonlySet<string>> {
  if (viewerDid === null) return NO_DIDS;

  const [own, reverse] = await Promise.all([
    blocks(viewerDid),
    blockedBy(viewerDid),
  ]);

  if (reverse.size === 0) return own;
  const union = new Set(own);
  for (const did of reverse) union.add(did);
  return union;
}

/**
 * The last recorded fetch attempt for `userDid`.
 *
 * The stamp is what separates "no blocks" from "never read" — a user with a
 * genuinely empty set has no rows to carry a timestamp, the same distinction
 * `profiles.ts` draws between a profile row and its negative cache. An absent
 * row reads as `fetchedAt: 0`, which is stale by definition.
 */
async function readFetchStamp(
  readStateDb: DbLike,
  userDid: string,
): Promise<{ fetchedAt: number; status: "ok" | "error" | null }> {
  const stamp = await readStateDb
    .query("select fetched_at, status from user_block_fetches where user_did = ?")
    .get<{ fetched_at: number; status: "ok" | "error" }>([userDid]);
  return {
    fetchedAt: stamp?.fetched_at ?? 0,
    status: stamp?.status ?? null,
  };
}

// ─── Refresh ───────────────────────────────────────────────────────────────

/**
 * Refresh `userDid`'s block set because *they* are present: an authenticated
 * request by that DID is the trigger, and another user's read never is.
 *
 * That is what makes the cost of the reverse direction proportional to the
 * accounts that use the appserver rather than to who shares a space with whom —
 * the rows a `blockedBy` read answers from are written by their own author's
 * fetch. The DIDs read are the DIDs that authenticate, and the stamp of the last
 * attempt bounds each of them to one PDS read per cache window.
 *
 * Detached by construction, so the request that triggers it is not slowed by it:
 * a Map lookup and a promise nobody awaits. The chain records its own failures —
 * this can never surface as an unhandled rejection or as an error on the request
 * that called it.
 *
 * The rows a read answers from change only when the fetch lands, and that is
 * when the memos derived from the previous ones go: this user's own set here,
 * the subjects' reverse sets inside `fetchAndStore`. A refresh that decided not
 * to fetch leaves both alone, so an ordinary request costs no DB re-read.
 */
export function warmBlockSet(userDid: string): void {
  if (inflightFetches.has(userDid)) return;
  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return;

  const refresh = (async () => {
    const stamp = await readFetchStamp(readStateDb, userDid);
    const age = Date.now() - stamp.fetchedAt;
    const due =
      stamp.status === "error"
        ? age >= blockErrorBackoffMs()
        : age >= blockCacheTtlMs();
    if (!due) return;
    if (!(await fetchAndStore(userDid, readStateDb))) return;
    writtenCache.delete(userDid);
  })()
    .catch((err) => {
      // `fetchAndStore` records its own failures; this is the outer guard so a
      // defect in it can never surface as an unhandled rejection.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[userBlocks] background refresh failed for ${userDid}: ${message}`);
    })
    .finally(() => {
      inflightFetches.delete(userDid);
    });

  inflightFetches.set(userDid, refresh);
}

/**
 * Fetch one user's blocks and replace their rows. Returns whether the fetch
 * produced an answer — never throws, because every caller is detached and a
 * failure belongs in the recorded state, not in a rejection nobody awaits.
 */
async function fetchAndStore(
  userDid: string,
  readStateDb: DbLike,
): Promise<boolean> {
  let records: BlockRecord[];
  try {
    records = await fetchBlockRecords(userDid);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[userBlocks] block fetch failed for ${userDid}: ${message}`);
    await recordFetchError(readStateDb, userDid);
    return false;
  }
  await replaceBlockRows(readStateDb, userDid, records);
  // These rows are the answer to *every* blocked account's reverse lookup, so no
  // reverse memo survives the replacement. Naming the subjects exactly would
  // mean reading the pre-fetch rows first; a memo entry costs one indexed read
  // to rebuild, and a clear cannot miss a subject.
  reverseCache.clear();
  return true;
}

/**
 * Replace a user's block rows and stamp the successful attempt.
 *
 * One transaction, because the delete and the inserts are a single replacement:
 * a crash between them would leave the user with an empty set — nobody hidden —
 * which is the one failure mode a block must not have.
 *
 * The insert is set-based. A block set is one account's whole repo and a repo is
 * not bounded: the largest account measured carries 16.5k blocks. A statement per
 * record costs ~6.9µs per record on a quiet readstate worker against ~3.4µs for
 * the set-based write below (50k-record fixture, `perf/probe-userblocks-replace.ts`),
 * and the worker serialises its requests, so the difference is also time every
 * other request on it spends queued. In production the shape has been logged
 * carrying 16653 records in 3400ms.
 *
 * The set travels as one JSON array of `[blocked_did, source, created_at]`: a
 * transaction step carries one SQL string and one params array, so the row set
 * has to arrive inside a single binding.
 *
 * Rows are deduplicated by `blocked_did`. The set is the union of two collections
 * and an account can hold several blocks naming one subject, so the records are
 * not unique on the primary key: one measured account's 16651 records resolved to
 * 15462 subjects, 1186 of them named more than once. A row per record aborts the
 * insert on the primary key, leaving that account's previous set in place.
 */
export async function replaceBlockRows(
  readStateDb: DbLike,
  userDid: string,
  records: readonly BlockRecord[],
): Promise<void> {
  const now = Date.now();
  // Last record wins, matching the order the two collections are read in: a
  // subject blocked in both Roomy and Bluesky is one row, not two.
  const byBlocked = new Map<string, BlockRecord>();
  for (const record of records) byBlocked.set(record.subject, record);
  const payload = JSON.stringify(
    [...byBlocked.values()].map((record) => [
      record.subject,
      record.source,
      record.createdAt,
    ]),
  );

  await readStateDb.transaction([
    {
      type: "run",
      sql: "delete from user_blocks where user_did = ?",
      params: [userDid],
    },
    {
      type: "run",
      sql: `insert into user_blocks (user_did, blocked_did, source, created_at, fetched_at)
            select ?, value ->> 0, value ->> 1, value ->> 2, ?
              from json_each(?)`,
      params: [userDid, now, payload],
    },
    {
      type: "run",
      sql: `insert into user_block_fetches (user_did, fetched_at, status)
          values (?, ?, 'ok')
          on conflict(user_did) do update set
            fetched_at = excluded.fetched_at,
            status = excluded.status`,
      params: [userDid, now],
    },
  ]);
}

/**
 * Stamp a failed attempt, leaving the rows alone.
 *
 * The rows are deliberately NOT cleared. They are the last known answer, and
 * their absence means "this user hides nobody" — so clearing them on a PDS blip
 * would silently stop hiding every author the user has blocked, which is the
 * exact failure the feature exists to prevent. A stale set is the safe
 * direction: it hides someone who has since been unblocked, until the next
 * successful refresh replaces it.
 */
export async function recordFetchError(
  readStateDb: DbLike,
  userDid: string,
): Promise<void> {
  await readStateDb.run(
    `insert into user_block_fetches (user_did, fetched_at, status)
     values (?, ?, 'error')
     on conflict(user_did) do update set
       fetched_at = excluded.fetched_at,
       status = excluded.status`,
    [userDid, Date.now()],
  );
}

/**
 * Refresh `userDid`'s block set now, in the caller's request, and report whether
 * the fetch succeeded.
 *
 * The immediate path after an in-app block: the write to the PDS has already
 * succeeded, and the TTL would otherwise leave the appserver handing out the
 * author's content for up to a minute. Awaited here because the caller is the
 * procedure whose whole purpose is to close that window; the client treats the
 * call itself as fire-and-forget.
 */
export async function refreshBlockSet(userDid: UserDid): Promise<boolean> {
  const readStateDb = tryOpenReadStateDb();
  if (!readStateDb) return false;
  writtenCache.delete(userDid);
  reverseCache.delete(userDid);
  return fetchAndStore(userDid, readStateDb);
}

/**
 * Drop the memo entries for `userDid`, so the next read re-resolves them.
 *
 * Called for the subject of a block as well as its author: a block changes what
 * *both* parties see, and the target's cached `hiddenBy` would otherwise keep the
 * reverse direction open for the rest of its TTL — the exact window the refresh
 * procedure exists to close.
 */
export function invalidateBlockSet(userDid: UserDid): void {
  writtenCache.delete(userDid);
  reverseCache.delete(userDid);
}

