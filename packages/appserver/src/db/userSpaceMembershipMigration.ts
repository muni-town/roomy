/**
 * One-time recovery of durable user-space membership intent from the event log.
 *
 * The v6 global repair derived active memberships from per-space `member`
 * edges, which resurrected spaces users had left (leaving persists the
 * `member` edge and only records `leftSpace` in the global DB). This migration
 * instead reduces the full join/leave history — both current
 * `space.roomy.space.*` and deprecated `space.roomy.space.personal.*` events —
 * ordered by event ULID per (user, space), and writes the winner into the
 * read-state `user_space_membership` table.
 *
 * Runs as a resumable read-state migration: the worker inserts a
 * `readstate_schema_migrations` row with `completed_at = null`; startup runs
 * this task and stamps completion only after full success. Interrupted runs
 * retry next boot. Idempotent.
 */

import { decode } from "@atcute/cbor";
import type { DbLike } from "./types.ts";
import { classifyMembershipEvent, type MembershipIntent } from "../queries/userSpaceMembership.ts";
import { log } from "../log.ts";

interface RawEvent {
  rowid: number;
  stream_id: string;
  user: string;
  payload: Uint8Array;
}

const SCAN_CHUNK = 50000;

/**
 * Reduce the event log into a (user, space) → latest membership intent map.
 * Bounded memory: only membership events are retained (a few thousand), and
 * the scan is chunked by rowid so the full log is never held in memory.
 */
export function reduceMembershipEvents(
  rows: RawEvent[],
): Map<string, MembershipIntent> {
  const out = new Map<string, MembershipIntent>();
  for (const r of rows) {
    let decoded: any;
    try {
      decoded = decode(r.payload);
    } catch {
      continue; // malformed payload — not a membership event
    }
    const ev = classifyMembershipEvent(decoded, r.stream_id, r.user);
    if (!ev) continue;
    const key = `${ev.userDid}\u0000${ev.spaceDid}`;
    const existing = out.get(key);
    if (!existing || compareUlid(ev.eventId, existing.eventId) > 0) {
      out.set(key, ev);
    }
  }
  return out;
}

/**
 * Compare two ULIDs by their canonical (uppercase) string form. ULIDs are
 * lexicographically sortable in Crockford base32, so string comparison is
 * correct. Case-insensitive to tolerate mixed-case event IDs.
 */
function compareUlid(a: string, b: string): number {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  return 0;
}

/**
 * Run the membership recovery. Scans the event log, reduces join/leave events
 * by latest ULID per (user, space), and writes the result into the read-state
 * `user_space_membership` table. Idempotent and resumable.
 */
export async function recoverUserSpaceMembership(
  db: DbLike,
): Promise<void> {
  const eventsDb = db.events?.() ?? db;
  const readStateDb = db.readState?.() ?? db;

  // Scan the event log in rowid-keyset chunks (indexed, O(n) total).
  const winners = new Map<string, MembershipIntent>();
  let lastRowid = 0;
  let scanned = 0;
  for (;;) {
    const rows = await eventsDb
      .query(
        `select rowid, stream_id, user, payload
           from stream_events
          where rowid > ?
          order by rowid
          limit ?`,
      )
      .all<RawEvent>([lastRowid, SCAN_CHUNK]);
    if (rows.length === 0) break;
    const chunk = reduceMembershipEvents(rows);
    for (const [key, ev] of chunk) {
      const existing = winners.get(key);
      if (!existing || compareUlid(ev.eventId, existing.eventId) > 0) {
        winners.set(key, ev);
      }
    }
    lastRowid = rows[rows.length - 1]!.rowid;
    scanned += rows.length;
  }

  log.info("startup", `membership recovery scanned ${scanned} events, ${winners.size} (user,space) intents`);

  // Write winners into the read-state table in one transaction.
  const steps = [...winners.values()].map((ev) => ({
    type: "run" as const,
    sql: `insert into user_space_membership
            (user_did, space_did, state, source, source_event_id, updated_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict(user_did, space_did) do update set
            state = excluded.state,
            source = excluded.source,
            source_event_id = excluded.source_event_id,
            updated_at = excluded.updated_at`,
    params: [ev.userDid, ev.spaceDid, ev.state, ev.source, ev.eventId, Date.now()],
  }));
  if (steps.length > 0) {
    await readStateDb.transaction(steps);
  }

  log.info("startup", `membership recovery wrote ${steps.length} durable membership rows`);
}

interface PendingMigration {
  version: string;
}

type ReadStateMigrationTask = (db: DbLike) => Promise<void>;

/**
 * Backfill `user_thread_activity.space_did` for rows written before the v7
 * schema added the column (they default to ''). The owning space of each
 * thread is resolved from the global `entity_space` index (entity → space),
 * then the read-state rows are updated in place. Idempotent and resumable.
 */
export async function backfillUserThreadActivitySpaceDid(
  db: DbLike,
): Promise<void> {
  const readStateDb = db.readState?.() ?? db;
  const globalDb = db.global?.();
  if (!globalDb) {
    log.info("startup", "no global DB handle; skipping user_thread_activity space_did backfill");
    return;
  }

  // Distinct thread_ids still missing a space_did.
  const missing = await readStateDb
    .query(
      `select distinct thread_id from user_thread_activity where space_did = ''`,
    )
    .all<{ thread_id: string }>();
  if (missing.length === 0) {
    log.info("startup", "user_thread_activity space_did backfill: nothing to do");
    return;
  }

  // Resolve each thread's owning space from the global entity_space index in
  // batched `in (...)` chunks.
  const spaceByThread = new Map<string, string>();
  const CHUNK = 500;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK).map((r) => r.thread_id);
    const ph = chunk.map(() => "?").join(",");
    const rows = await globalDb
      .query(
        `select entity_id, space_did from entity_space where entity_id in (${ph})`,
      )
      .all<{ entity_id: string; space_did: string }>(...chunk);
    for (const r of rows) spaceByThread.set(r.entity_id, r.space_did);
  }

  // Update rows in place, one transaction per chunk.
  let updated = 0;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const steps: Array<{
      type: "run";
      sql: string;
      params: unknown[];
    }> = [];
    for (const { thread_id } of chunk) {
      const spaceDid = spaceByThread.get(thread_id);
      if (!spaceDid) continue; // thread not in entity_space — leave '' (unresolvable)
      steps.push({
        type: "run",
        sql: `update user_thread_activity set space_did = ? where thread_id = ? and space_did = ''`,
        params: [spaceDid, thread_id],
      });
    }
    if (steps.length > 0) {
      await readStateDb.transaction(steps);
      updated += steps.length;
    }
  }

  log.info("startup", `user_thread_activity space_did backfill updated ${updated} rows`);
}

/**
 * Async/data migrations keyed by the read-state schema version that scheduled
 * them. Structural DDL is applied synchronously by the DB worker; these tasks
 * may scan the event log and therefore run from the main thread.
 */
const READSTATE_MIGRATION_TASKS: Record<string, ReadStateMigrationTask> = {
  "6": recoverUserSpaceMembership,
  "7": backfillUserThreadActivitySpaceDid,
};

/**
 * Run incomplete read-state post-migrations in version order.
 *
 * Completion is stamped only after a task succeeds in full. Tasks must be
 * idempotent: if the process exits midway, the null marker remains and the
 * whole task is retried on the next boot.
 */
export async function runPendingReadStateMigrations(
  db: DbLike,
): Promise<void> {
  const readStateDb = db.readState?.() ?? db;
  const pending = await readStateDb
    .query(
      `select version
         from readstate_schema_migrations
        where completed_at is null
        order by cast(version as integer)`,
    )
    .all<PendingMigration>();

  for (const { version } of pending) {
    const task = READSTATE_MIGRATION_TASKS[version];
    if (!task) {
      throw new Error(`No read-state post-migration task registered for schema v${version}`);
    }

    log.info("startup", `running read-state post-migration v${version}`);
    await task(db);
    await readStateDb.run(
      `update readstate_schema_migrations
          set completed_at = ?
        where version = ? and completed_at is null`,
      Date.now(),
      version,
    );
    log.info("startup", `read-state post-migration v${version} complete`);
  }
}

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

export interface ReadStateMigrationRetryOpts {
  /** Number of attempts before giving up (default 3). */
  attempts?: number;
  /** Delay between attempts in ms (default 1000). */
  delayMs?: number;
}

/**
 * Run pending read-state post-migrations with a few retries, then fail fast.
 *
 * The boot path must not serve reads with an empty `user_space_membership`
 * (getSpaces would silently hide every user's spaces). A transient DB hiccup
 * is retried; a persistent failure throws so the process exits and the
 * orchestrator restarts, which retries the resumable migration from where it
 * left off.
 */
export async function runPendingReadStateMigrationsWithRetry(
  db: DbLike,
  opts: ReadStateMigrationRetryOpts = {},
): Promise<void> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const delayMs = opts.delayMs ?? RETRY_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runPendingReadStateMigrations(db);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        log.warn(
          "startup",
          `read-state post-migration attempt ${attempt}/${attempts} failed, retrying: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw new Error(
    `read-state post-migration failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
