/**
 * Backfill the change feed (`record_changes`) from the event log.
 *
 * `StreamManager.sendEvents` writes the feed as it appends, so the table holds
 * every change the log has emitted since the feature shipped. This script
 * fills in the entries that predate it (or repairs a partial write) by walking
 * a stream's `stream_events` in `idx` order and running the same adapter the
 * write path runs.
 *
 * Idempotent: rows are written with `insert or replace` keyed by
 * `(stream_id, idx, ord)`, so re-running over the same range rewrites the same
 * rows. There is no boot sweep — the feed is repaired by running this when the
 * log is cold, never at startup.
 *
 * Usage:
 *   bun run scripts/backfill-record-changes.ts [--data-dir <dir>] [--events <path>]
 *                                              [--stream <did>] [--dry-run]
 *
 * Run while the appserver is stopped, or expect SQLITE_BUSY retries — the
 * script sets a busy timeout.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { decode } from "@atcute/cbor";
import type { Event, StreamDid, StreamIndex, UserDid } from "@roomy-space/sdk";

import { toAsyncDb } from "../src/db/syncAdapter.ts";
import type { LoggedEvent } from "../src/materialization/types.ts";
import { feedRows, writeRecordChanges } from "../src/streams/recordChanges.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const dataDir = flag("data-dir") ?? process.env.DATA_DIR ?? "data";
const eventsPath = flag("events") ?? join(dataDir, "roomy-events.sqlite");
const onlyStream = flag("stream");
const dryRun = args.includes("--dry-run");

const db = new Database(eventsPath, { readwrite: true });
db.exec("pragma busy_timeout = 5000");
// The feed lives in this DB, so the schema that declares it is applied here
// too: the table is additive and this is the one statement that creates it.
db.exec(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "db",
      "eventsSchema.sql",
    ),
    "utf8",
  ),
);

const sql = toAsyncDb(db);

/** The streams to walk, in `idx` order within each. */
const streams: string[] = onlyStream
  ? [onlyStream]
  : db
      .query<{ stream_id: string }, []>(
        "select distinct stream_id from stream_events order by stream_id",
      )
      .all()
      .map((row) => row.stream_id);

let totalChanges = 0;
for (const stream of streams) {
  const rows = db
    .query<
      {
        idx: number;
        user: string;
        payload: Uint8Array;
        received_at: number | null;
        created_at: number | null;
      },
      [string]
    >(
      `select idx, user, payload, received_at, created_at
         from stream_events
        where stream_id = ?
        order by idx`,
    )
    .all(stream);

  let changes = 0;
  const batch: LoggedEvent[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    if (!dryRun) await writeRecordChanges(sql, stream as StreamDid, batch);
    changes += batch.reduce(
      (n, entry) => n + feedRows(entry, stream as StreamDid).length,
      0,
    );
    batch.length = 0;
  };

  for (const row of rows) {
    batch.push({
      event: decode(row.payload) as Event,
      idx: row.idx as StreamIndex,
      user: row.user as UserDid,
      // A row that predates both columns orders by its sender-minted ULID
      // time, the same fallback `materialization/sortIdx.ts` applies.
      receivedAt: row.received_at ?? undefined,
      createdAt: row.created_at ?? undefined,
    });
    // The feed is written in the same batch sizes the write path uses, so a
    // crash mid-script leaves whole batches behind and a re-run completes them.
    if (batch.length >= 500) await flush();
  }
  await flush();

  totalChanges += changes;
  process.stdout.write(
    `${stream}: ${rows.length} events, ${changes} changes${dryRun ? " (dry run)" : ""}\n`,
  );
}

db.close();
process.stdout.write(`done: ${totalChanges} changes across ${streams.length} streams\n`);
