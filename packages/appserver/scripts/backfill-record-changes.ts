/**
 * Backfill — and audit — the change feed (`record_changes`) from the event log.
 *
 * `StreamManager.sendEvents` writes the feed as it appends, so the table holds
 * every change the log has emitted since the feature shipped. Two modes use the
 * same adapter the write path runs:
 *
 *  - **write** (default) fills in the entries that predate the feature, or
 *    repairs a partial write, by walking a stream's `stream_events` in `idx`
 *    order. Idempotent: rows are written with `insert or replace` keyed by
 *    `(stream_id, idx, ord)`, so re-running over the same range rewrites the
 *    same rows. There is no boot sweep — the feed is repaired by running this
 *    when the log is cold, never at startup.
 *  - **`--verify`** compares the log to the feed and reports every entry whose
 *    event type declares a converted kind but which the feed holds no row for.
 *    A short feed is otherwise silent: the consumer that applies it sees fewer
 *    changes, and SQLite says nothing but the foreign-key failure a missing
 *    parent entity causes. The audit turns that into a finding an operator can
 *    act on.
 *
 * An entry is a gap when the adapter emits changes for it and the feed holds
 * none (or fewer), and also when the adapter cannot describe it — the write
 * path drops such an entry, so the feed is short by it. A type that declares no
 * record is not a gap: the feed is complete without it.
 *
 * Usage:
 *   bun run scripts/backfill-record-changes.ts [--data-dir <dir>] [--events <path>]
 *                                              [--stream <did>] [--dry-run]
 *   bun run scripts/backfill-record-changes.ts --verify [--json]
 *                                              [--data-dir <dir>] [--events <path>]
 *                                              [--stream <did>]
 *
 * `--verify` exits 0 when every stream's feed is complete, 1 when any gap
 * exists, and 2 when the check could not run (an unreadable or non-event
 * database). Repair is the write mode.
 *
 * Run while the appserver is stopped, or expect SQLITE_BUSY retries — both modes
 * set a busy timeout.
 *
 * A follower that has already committed a cursor will never read the rows this
 * script inserts below it: the worker asks the feed for `idx > cursor`. Running
 * a backfill while a follower has been running therefore requires deleting that
 * follower's per-space DBs; restarting the follower is not enough, because the
 * cursor it resumes from is what skips the new rows.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { decode } from "@atcute/cbor";
import type { Event, StreamDid, StreamIndex, UserDid } from "@roomy-space/sdk";

import { toAsyncDb } from "../src/db/syncAdapter.ts";
import type { LoggedEvent } from "../src/materialization/types.ts";
import {
  feedGap,
  feedRows,
  writeRecordChanges,
  type FeedGap,
} from "../src/streams/recordChanges.ts";

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "db",
  "eventsSchema.sql",
);

/** One `stream_events` row, as both modes read it. */
interface EventRow {
  idx: number;
  user: string;
  payload: Uint8Array;
  received_at: number | null;
  created_at: number | null;
}

/** The entry a log row decodes to. */
function loggedFromRow(row: EventRow): LoggedEvent {
  return {
    event: decode(row.payload) as Event,
    idx: row.idx as StreamIndex,
    user: row.user as UserDid,
    // A row that predates both columns orders by its sender-minted ULID
    // time, the same fallback `materialization/sortIdx.ts` applies.
    receivedAt: row.received_at ?? undefined,
    createdAt: row.created_at ?? undefined,
  };
}

/** The streams an invocation walks: the named one, or every stream in the log. */
function streamsIn(db: Database, only: string | undefined): string[] {
  if (only !== undefined) return [only];
  return db
    .query<{ stream_id: string }, []>(
      "select distinct stream_id from stream_events order by stream_id",
    )
    .all()
    .map((row) => row.stream_id);
}

function eventsIn(db: Database, stream: string): EventRow[] {
  return db
    .query<EventRow, [string]>(
      `select idx, user, payload, received_at, created_at
         from stream_events
        where stream_id = ?
        order by idx`,
    )
    .all(stream);
}

// ── audit ────────────────────────────────────────────────────────────────

/** One stream's comparison of the log against the feed. */
export interface StreamAudit {
  stream: string;
  /** Log entries walked. */
  events: number;
  /** Entries the feed has no row for. */
  gaps: number;
}

export interface AuditReport {
  /** The events database the audit read. */
  events: string;
  streams: StreamAudit[];
  /** Every gap, across streams, in stream then `idx` order. */
  gaps: FeedGap[];
  /** Set when the check could not run, which makes the report uninformative. */
  error?: string;
}

export interface AuditOptions {
  eventsPath: string;
  /** Audit only this stream. */
  stream?: string;
}

/** Whether a table exists, so a log without the feed reads as all-gaps. */
function hasTable(db: Database, name: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "select count(*) as n from sqlite_master where type = 'table' and name = ?",
    )
    .get(name);
  return row?.n === 1;
}

/** The `ord` values the feed holds per `idx`, for one stream. */
function feedOrds(db: Database, stream: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const rows = db
    .query<{ idx: number; ord: number }, [string]>(
      "select idx, ord from record_changes where stream_id = ? order by idx, ord",
    )
    .all(stream);
  for (const row of rows) {
    const ords = out.get(row.idx);
    if (ords === undefined) out.set(row.idx, [row.ord]);
    else ords.push(row.ord);
  }
  return out;
}

/** Audit one stream. The database is open on the caller's side. */
function auditStream(
  db: Database,
  stream: string,
  withFeed: boolean,
): { stream: string; events: number; gaps: FeedGap[] } {
  const ords = withFeed ? feedOrds(db, stream) : new Map<number, number[]>();
  const rows = eventsIn(db, stream);
  const gaps: FeedGap[] = [];
  for (const row of rows) {
    const gap = feedGap(
      loggedFromRow(row),
      stream as StreamDid,
      ords.get(row.idx) ?? [],
    );
    if (gap !== null) gaps.push(gap);
  }
  return { stream, events: rows.length, gaps };
}

/**
 * Compare every selected stream's log against its feed. Read-only: the handle
 * refuses writes, so an audit can never repair what it finds.
 */
export async function verifyFeed(
  opts: AuditOptions,
): Promise<{ report: AuditReport; exitCode: 0 | 1 | 2 }> {
  const report: AuditReport = { events: opts.eventsPath, streams: [], gaps: [] };

  let db: Database | null = null;
  try {
    db = new Database(opts.eventsPath, { readonly: true });
    db.exec("pragma busy_timeout = 5000");
    if (!hasTable(db, "stream_events")) {
      throw new Error("no stream_events table: not an events database");
    }
    const withFeed = hasTable(db, "record_changes");
    for (const stream of streamsIn(db, opts.stream)) {
      const audit = auditStream(db, stream, withFeed);
      report.streams.push({
        stream: audit.stream,
        events: audit.events,
        gaps: audit.gaps.length,
      });
      report.gaps.push(...audit.gaps);
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        /* best-effort: a handle that failed to open has nothing to close */
      }
    }
  }

  const exitCode: 0 | 1 | 2 =
    report.error !== undefined ? 2 : report.gaps.length > 0 ? 1 : 0;
  return { report, exitCode };
}

/**
 * The audit as text: a total line, then one line per stream — complete or not —
 * with each of its gaps indented under it.
 */
export function formatAudit(report: AuditReport): string {
  const events = report.streams.reduce((n, s) => n + s.events, 0);
  const lines = [
    `record_changes audit: ${report.streams.length} streams, ${events} events, ` +
      `${report.gaps.length} ${report.gaps.length === 1 ? "gap" : "gaps"}`,
  ];
  if (report.error !== undefined) lines.push(`error: ${report.error}`);
  for (const stream of report.streams) {
    lines.push(
      `${stream.stream}: ${stream.events} events, ${stream.gaps} ` +
        `${stream.gaps === 1 ? "gap" : "gaps"} — ` +
        `${stream.gaps === 0 ? "complete" : "incomplete"}`,
    );
    for (const gap of report.gaps) {
      if (gap.stream !== stream.stream) continue;
      lines.push(`  idx ${gap.idx}  ${gap.eventId}  ${gap.type}  ${gap.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ── backfill ─────────────────────────────────────────────────────────────

export interface BackfillOptions {
  eventsPath: string;
  /** Backfill only this stream. */
  stream?: string;
  dryRun: boolean;
}

export interface BackfillReport {
  /** One line per stream, in `idx` order within each. */
  streams: { stream: string; events: number; changes: number }[];
  changes: number;
  dryRun: boolean;
  error?: string;
}

/** Write the feed for every selected stream, in the batches the write path uses. */
export async function runBackfill(
  opts: BackfillOptions,
): Promise<{ report: BackfillReport; exitCode: 0 | 2 }> {
  const report: BackfillReport = {
    streams: [],
    changes: 0,
    dryRun: opts.dryRun,
  };

  let db: Database | null = null;
  try {
    db = new Database(opts.eventsPath, { readwrite: true });
    db.exec("pragma busy_timeout = 5000");
    // The feed lives in this DB, so the schema that declares it is applied here
    // too: the table is additive and this is the one statement that creates it.
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));

    const sql = toAsyncDb(db);
    for (const stream of streamsIn(db, opts.stream)) {
      const rows = eventsIn(db, stream);
      let changes = 0;
      const batch: LoggedEvent[] = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        if (!opts.dryRun) await writeRecordChanges(sql, stream as StreamDid, batch);
        changes += batch.reduce(
          (n, entry) => n + feedRows(entry, stream as StreamDid).length,
          0,
        );
        batch.length = 0;
      };

      for (const row of rows) {
        batch.push(loggedFromRow(row));
        // The feed is written in the same batch sizes the write path uses, so a
        // crash mid-script leaves whole batches behind and a re-run completes
        // them.
        if (batch.length >= 500) await flush();
      }
      await flush();

      report.streams.push({ stream, events: rows.length, changes });
      report.changes += changes;
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  }

  return { report, exitCode: report.error === undefined ? 0 : 2 };
}

/** The backfill's summary: one line per stream, then the total. */
export function formatBackfill(report: BackfillReport): string {
  const lines = report.streams.map(
    (s) =>
      `${s.stream}: ${s.events} events, ${s.changes} changes` +
      `${report.dryRun ? " (dry run)" : ""}`,
  );
  if (report.error !== undefined) lines.push(`error: ${report.error}`);
  lines.push(
    `done: ${report.changes} changes across ${report.streams.length} streams`,
  );
  return `${lines.join("\n")}\n`;
}

// ── arguments ────────────────────────────────────────────────────────────

const USAGE =
  "usage: bun run scripts/backfill-record-changes.ts [--data-dir <dir>] " +
  "[--events <file>] [--stream <did>] [--dry-run]\n" +
  "       bun run scripts/backfill-record-changes.ts --verify [--json] " +
  "[--data-dir <dir>] [--events <file>] [--stream <did>]";

export interface ParsedArgs {
  eventsPath: string;
  stream?: string;
  dryRun: boolean;
  verify: boolean;
  json: boolean;
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { ok: true; value: ParsedArgs } | { ok: false; error: string } {
  const values = new Map<string, string>();
  let verify = false;
  let json = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      return { ok: false, error: `unexpected argument: ${arg}` };
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (["--data-dir", "--events", "--stream"].includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "") {
        return { ok: false, error: `${name} needs a value` };
      }
      values.set(name, value);
      continue;
    }
    return { ok: false, error: `unknown flag: ${name}` };
  }

  if (json && !verify) return { ok: false, error: "--json needs --verify" };
  if (dryRun && verify) return { ok: false, error: "--dry-run needs a write run" };

  return {
    ok: true,
    value: {
      eventsPath:
        values.get("--events") ??
        join(values.get("--data-dir") ?? env.DATA_DIR ?? "data", "roomy-events.sqlite"),
      stream: values.get("--stream"),
      dryRun,
      verify,
      json,
    },
  };
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${USAGE}`);
    process.exitCode = 2;
  } else if (parsed.value.verify) {
    const { report, exitCode } = await verifyFeed({
      eventsPath: parsed.value.eventsPath,
      stream: parsed.value.stream,
    });
    process.stdout.write(
      parsed.value.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatAudit(report),
    );
    process.exitCode = exitCode;
  } else {
    const { report, exitCode } = await runBackfill({
      eventsPath: parsed.value.eventsPath,
      stream: parsed.value.stream,
      dryRun: parsed.value.dryRun,
    });
    process.stdout.write(formatBackfill(report));
    process.exitCode = exitCode;
  }
}
