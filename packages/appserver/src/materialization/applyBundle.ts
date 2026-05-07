/**
 * Apply a single materialised event's SQL statements to the database.
 *
 * Each event runs inside its own SAVEPOINT so a single failing event rolls
 * back cleanly without poisoning the rest of the batch. This is stricter than
 * the frontend's per-statement error tolerance: the appserver treats partial
 * application as a bug, not a feature.
 *
 * Side-effects (sort_idx, unread counter) live here rather than inside the SDK
 * materialisers because the original design keeps materialisers free of
 * backfill awareness.
 */

import { Database } from "bun:sqlite";
import type { StreamDid } from "@roomy-space/sdk";
import type { SqlStatement, StatementBundleSuccess } from "./types.ts";
import {
  setMessageSortIdxByReorder,
  setMessageSortIdxByTimestamp,
} from "./sortIdx.ts";

export interface ApplyBundleOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
  streamId: StreamDid;
}

export function applyBundle(
  db: Database,
  bundle: StatementBundleSuccess,
  opts: ApplyBundleOpts,
): void {
  const savepoint = `evt_${bundle.event.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  db.exec(`savepoint ${savepoint}`);

  try {
    for (const statement of bundle.statements) {
      runStatement(db, statement);
    }

    setMessageSortIdxByTimestamp(db, bundle.event);
    setMessageSortIdxByReorder(db, opts.streamId, bundle.event);

    if (
      !opts.isBackfill &&
      bundle.event.$type === "space.roomy.message.createMessage.v0" &&
      bundle.event.room
    ) {
      // Increment unread for live createMessage events. Mirrors the frontend
      // patch in worker.ts → listenEvents.
      db.prepare(
        `insert into comp_last_read (entity, last_read, unread_count)
         values (?, 0, 1)
         on conflict(entity) do update set
           unread_count = comp_last_read.unread_count + 1,
           updated_at = (unixepoch() * 1000)`,
      ).run(bundle.event.room);
    }

    db.exec(`release ${savepoint}`);
  } catch (e) {
    db.exec(`rollback to ${savepoint}`);
    db.exec(`release ${savepoint}`);
    throw e;
  }
}

function runStatement(db: Database, statement: SqlStatement): void {
  const stmt = db.prepare(statement.sql);
  const params = statement.params;
  if (params === undefined) {
    stmt.run();
  } else if (Array.isArray(params)) {
    stmt.run(...(params as unknown[] as never[]));
  } else {
    stmt.run(params as never);
  }
}
