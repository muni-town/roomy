/**
 * One-time repair script: rebuild activity timestamps with canonical message
 * times.
 *
 * Background: bridged messages carry a `timestampOverride` extension (the
 * original Discord send time), but their ULIDs encode bridge-ingestion time.
 * The activity_item upsert and the user_thread_activity refresh used the ULID
 * time, so getThreads / getActivityFeed / the sidebar's active-threads list
 * ordered bridged threads by ingestion order — for a backfill that is reverse
 * Discord-chronological (rooms created in backfill order, messages ingested
 * oldest-first per channel). This script rewrites:
 *
 *   1. `activity_item` rows (per-space DBs) — last_activity_at and the
 *      recent_message_ids window, from the canonical `comp_content.timestamp`
 *      (the same value the SDK materialiser writes).
 *   2. `user_thread_activity` rows (read-state DB) — last_active_at, from the
 *      owning thread's canonical max message timestamp.
 *
 * Idempotent: re-running recomputes the same values. Rows whose messages have
 * no `comp_content` row (deleted) fall back to the message ULID time.
 *
 * Usage:
 *   bun run scripts/repair-activity-timestamps.ts [--data-dir <dir>] [--dry-run]
 *
 * Run while the appserver is stopped (or expect SQLITE_BUSY retries — the
 * script sets a 5s busy timeout).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { decodeTime } from "ulidx";

// ─── Config ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dataDir = args.includes("--data-dir")
  ? args[args.indexOf("--data-dir") + 1] ?? "data"
  : "data";
const dryRun = args.includes("--dry-run");

const spacesDir = join(dataDir, "spaces");
const readStatePath = join(dataDir, "roomy-readstate.sqlite");

interface ActivityRow {
  room_id: string;
  last_activity_at: number;
  recent_message_ids: string;
}

interface ContentRow {
  timestamp: number | null;
}

interface ThreadActivityRow {
  user_did: string;
  thread_id: string;
  space_did: string;
  last_active_at: number;
}

/** Canonical timestamp for a message: comp_content.timestamp, else ULID time. */
function canonicalTs(db: Database, messageId: string): number {
  const row = db
    .query("select timestamp from comp_content where entity = ?")
    .get<ContentRow>(messageId);
  if (row?.timestamp != null) return row.timestamp;
  try {
    return decodeTime(messageId);
  } catch {
    return 0;
  }
}

/** Repair `activity_item` in one per-space DB. Returns rows changed. */
function repairActivityItems(db: Database): number {
  const rows = db
    .query("select room_id, last_activity_at, recent_message_ids from activity_item")
    .all<ActivityRow>();

  let changed = 0;
  for (const row of rows) {
    let entries: Array<{ id: string; ts: number }>;
    try {
      const parsed: unknown = JSON.parse(row.recent_message_ids);
      if (!Array.isArray(parsed)) continue;
      entries = [];
      for (const item of parsed) {
        if (typeof item === "string") {
          entries.push({ id: item, ts: canonicalTs(db, item) });
        } else if (
          item !== null &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).id === "string"
        ) {
          const id = (item as Record<string, unknown>).id as string;
          entries.push({ id, ts: canonicalTs(db, id) });
        }
      }
    } catch {
      continue; // malformed JSON — leave the row untouched
    }

    if (entries.length === 0) continue;

    // Newest first by canonical time; cap at 5.
    entries.sort((a, b) => b.ts - a.ts);
    const capped = entries.slice(0, 5);
    const lastActivityAt = capped[0]!.ts;
    const newIds = JSON.stringify(capped);

    if (lastActivityAt === row.last_activity_at && newIds === row.recent_message_ids) {
      continue; // already correct
    }

    changed++;
    if (!dryRun) {
      db.run(
        `update activity_item
            set last_activity_at = ?, recent_message_ids = ?, updated_at = (unixepoch() * 1000)
          where room_id = ?`,
        lastActivityAt,
        newIds,
        row.room_id,
      );
    }
  }
  return changed;
}

/**
 * Repair `user_thread_activity` in the read-state DB. The canonical
 * last-active time for a thread is the max canonical message timestamp in
 * that thread, computed from the owning per-space DB.
 */
function repairUserThreadActivity(
  readState: Database,
  spaceDbs: Map<string, Database>,
): number {
  const rows = readState
    .query("select user_did, thread_id, space_did, last_active_at from user_thread_activity")
    .all<ThreadActivityRow>();

  // Per-thread canonical max timestamp, computed once per owning space DB.
  const canonicalByThread = new Map<string, number>();
  for (const [spaceDid, db] of spaceDbs) {
    const threadRows = db
      .query(
        `select e.room as room, max(cc.timestamp) as ts
           from entities e
           join comp_content cc on cc.entity = e.id
          where e.room is not null
          group by e.room`,
      )
      .all<{ room: string; ts: number | null }>();
    for (const t of threadRows) {
      if (t.ts == null) continue;
      canonicalByThread.set(`${spaceDid}::${t.room}`, t.ts);
    }
  }

  let changed = 0;
  for (const row of rows) {
    const canonical = canonicalByThread.get(`${row.space_did}::${row.thread_id}`);
    if (canonical == null || canonical === row.last_active_at) continue;
    changed++;
    if (!dryRun) {
      readState.run(
        `update user_thread_activity
            set last_active_at = ?, updated_at = (unixepoch() * 1000)
          where user_did = ? and thread_id = ?`,
        canonical,
        row.user_did,
        row.thread_id,
      );
    }
  }
  return changed;
}

function main(): void {
  if (!existsSync(spacesDir)) {
    console.log(`No spaces dir at ${spacesDir}; nothing to repair.`);
    return;
  }

  const files = readdirSync(spacesDir).filter((f) => f.endsWith(".sqlite"));
  if (files.length === 0) {
    console.log(`No per-space DBs in ${spacesDir}; nothing to repair.`);
    return;
  }

  let totalRows = 0;
  let totalChanged = 0;
  const spaceDbs = new Map<string, Database>();

  for (const file of files) {
    const path = join(spacesDir, file);
    const db = dryRun ? new Database(path, { readonly: true }) : new Database(path);
    db.exec("pragma busy_timeout = 5000");

    const rows = db
      .query("select count(*) as c from activity_item")
      .get<{ c: number }>()?.c ?? 0;
    const changed = repairActivityItems(db);
    totalRows += rows;
    totalChanged += changed;
    console.log(
      `${file}: ${changed}/${rows} activity_item rows ${dryRun ? "would change" : "updated"}`,
    );

    spaceDbs.set(file.replace(/\.sqlite$/, ""), db);
  }

  // Phase 2: user_thread_activity in the read-state DB.
  if (existsSync(readStatePath)) {
    const readState = dryRun
      ? new Database(readStatePath, { readonly: true })
      : new Database(readStatePath);
    readState.exec("pragma busy_timeout = 5000");
    const utaChanged = repairUserThreadActivity(readState, spaceDbs);
    readState.close();
    totalChanged += utaChanged;
    console.log(
      `roomy-readstate.sqlite: ${utaChanged} user_thread_activity rows ${dryRun ? "would change" : "updated"}`,
    );
  } else {
    console.log(`No read-state DB at ${readStatePath}; skipping user_thread_activity.`);
  }

  for (const db of spaceDbs.values()) db.close();

  console.log(
    `${dryRun ? "[dry-run] " : ""}Done: ${totalChanged} rows affected across ${files.length} spaces.`,
  );
}

main();
