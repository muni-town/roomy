/**
 * Rebuild-equality oracle.
 *
 * A per-space DB is defined as a deterministic projection of the event log
 * (`docs/plans/pure-materialisation.md` §2): the same log prefix and the same
 * schema version, materialised twice — at different wall-clock times, in
 * different processes, without network access — hold the same derived state,
 * modulo an explicit exclusion list. This module is the check for that
 * statement, and `docs/plans/replicable-space-workers.md` §7 makes it the
 * acceptance oracle for WS1, for WS3 (the change-record interface) and for the
 * TS-vs-Rust comparison in WS4.
 *
 * Three primitives, in the order a caller composes them:
 *
 *   `snapshotSpaceDb(spaceDb)`      read every derived table out of one DB
 *   `diffSnapshots(a, b)`           name the tables the two readings disagree on
 *   `digestOf(tables)`              one hash over a reading, for golden files
 *
 * `materialiseAndDiff(db, streamDid)` is the composed check for the case the TS
 * appserver runs by itself: derive the space from the log, derive it again
 * through the real rebuild path (blue-green: replay the whole log into a fresh
 * `.sqlite.new` DB and swap it in) and diff. That is plan §6 P3 and P7 — the
 * per-space tables a rebuild produces are the ones a live write produced, and
 * no table has a writer outside materialisation.
 *
 * **Cross-implementation use (WS4).** Point two implementations at the same log
 * and compare the per-space DBs they produce — nothing here depends on how a DB
 * was built, only on its schema. A TS driver against a Rust-produced file:
 *
 *   const rust = await snapshotSpaceDb(toAsyncDb(new Database(rustPath)));
 *   const ts = await snapshotSpaceDb(toAsyncDb(new Database(tsPath)));
 *   const diverging = diffSnapshots(ts, rust);          // the tables that differ
 *   digestOf(ts) === digestOf(rust)                     // or one hash per side
 *
 * `toAsyncDb` is `db/syncAdapter.ts`. `digestOf` is the cheap form for a
 * shadow-materialise-and-diff that runs on every boot: compare a hash against a
 * recorded TS digest, and fall back to `diffSnapshots` only when they differ.
 *
 * **Exclusions.** The three sets below name the values the log does not
 * determine, and each is load-bearing:
 *
 *   `CLOCK_COLUMNS`      columns carrying the *derivation* instant rather than
 *                        a value the log determines (plan §3.4). Dropped from
 *                        every table. `reMaterialize.purity.test.ts` pins both
 *                        the list itself and that one of its columns really is
 *                        derivation-time, so it cannot quietly grow to cover a
 *                        log-determined value.
 *   `NON_DERIVED_TABLES` tables holding no derived state at all.
 *   `READ_PATH_CACHES`   tables left out of one comparison, passed as
 *                        `ignoredTables` rather than applied by default. The
 *                        documented read-path warms belong here (plan §3.3):
 *                        they hold values the log determines, but reads
 *                        populate them, so a rebuild leaves them empty where a
 *                        live write left them filled. Between two rebuilds the
 *                        caches must agree too, so this is opt-in.
 */

import { createHash } from "node:crypto";
import type { StreamDid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { reMaterializeFromLocalEvents } from "./reMaterialize.ts";

/**
 * Columns that carry the derivation's own instant rather than a value the log
 * determines (plan §3.4). Two derivations are expected to differ in these and
 * only these.
 */
export const CLOCK_COLUMNS: Readonly<Record<string, true>> = {
  created_at: true,
  updated_at: true,
  fetched_at: true,
  synced_at: true,
  retry_after: true,
};

/** Tables in a per-space DB that are not derived state at all. */
export const NON_DERIVED_TABLES: Readonly<Record<string, true>> = {
  space_schema_version: true,
  space_schema_migrations: true,
};

/**
 * The documented read-path caches (plan §3.3). They hold values the log
 * determines, but they are populated by reads rather than by materialisation: a
 * replay invalidates them and the next read warms them again. So a rebuild
 * leaves them empty where a live write left them populated, which is a
 * difference in *when* they are filled, not in what they would hold.
 */
export const READ_PATH_CACHES: Readonly<Record<string, true>> = {
  room_access: true,
  room_activity: true,
};

/**
 * Cursors a *worker* comparison leaves out: each implementation's own progress
 * marker in the per-space DB. The TS materialiser's is `materialization_cursor`
 * (plus the legacy `comp_space.backfilled_to` column) and a space worker's is
 * `worker_cursor`; neither is state the log determines, and neither
 * implementation writes the other's.
 *
 * `snapshotSpaceDb` keeps them, because a rebuild of *one* implementation must
 * reproduce its own cursor. A TS-vs-worker comparison drops them through
 * {@link workerSnapshot}.
 */
export const CURSOR_TABLES: Readonly<Record<string, true>> = {
  materialization_cursor: true,
  worker_cursor: true,
};

/** Columns holding a cursor rather than a log-determined value. */
export const CURSOR_COLUMNS: Readonly<Record<string, true>> = {
  backfilled_to: true,
};

/**
 * A snapshot with the cursor tables and columns dropped, for comparing two
 * implementations' projections of the same log.
 */
export function workerSnapshot(tables: TableSnapshot[]): TableSnapshot[] {
  const out: TableSnapshot[] = [];
  for (const table of tables) {
    if (CURSOR_TABLES[table.table]) continue;
    const keep = table.columns
      .map((column, i) => (CURSOR_COLUMNS[column] ? -1 : i))
      .filter((i) => i >= 0);
    out.push({
      table: table.table,
      columns: table.columns.filter((column) => !CURSOR_COLUMNS[column]),
      rows: table.rows.map((row) => keep.map((i) => row[i])),
    });
  }
  return out;
}

/** One table's rows, as read out of a per-space DB. */
export interface TableSnapshot {
  table: string;
  /** The table's columns in declaration order, clock columns dropped. */
  columns: string[];
  /** Rows in canonical order; each row follows `columns`. */
  rows: unknown[][];
}

/** One table two derivations disagree on. */
export interface TableDivergence {
  table: string;
  /** The table's rows in the first derivation; empty if the table is new. */
  before: unknown[][];
  /** The table's rows in the second derivation; empty if the table is gone. */
  after: unknown[][];
}

/** Two derivations of one log, and the tables they disagree on. */
export interface RebuildEquality {
  before: TableSnapshot[];
  after: TableSnapshot[];
  /** Empty when the two derivations agree on every table not ignored. */
  diverging: TableDivergence[];
}

/** How a derivation is produced and what it is compared against. */
export interface MaterialiseAndDiffOpts {
  /**
   * The first derivation to compare against. Taken from the canonical DB when
   * omitted; pass a reading taken from a live write (or from another
   * implementation's DB) to compare against something else. That is also how a
   * value produced outside materialisation is pinned against the rebuild — read
   * the DB after enriching a URL with the embed sweeper, and the diff names the
   * table the rebuild failed to reproduce.
   */
  before?: TableSnapshot[];
  /** Tables to leave out of the comparison (see `READ_PATH_CACHES`). */
  ignoredTables?: Iterable<string>;
}

/** One outbound request a spied-on `fetch` refused. */
export interface FetchCall {
  url: string;
  method: string;
}

/**
 * Read every derived per-space table into a snapshot.
 *
 * Columns come back in declaration order (what `pragma_table_info` reports, and
 * what `schema-space.sql` writes them in), so two readings of the same schema
 * line up column for column. Rows are ordered by the canonical encoding the
 * comparison and the digest both use, so a table holding the same rows in a
 * different physical order still reads the same. The clock columns and the
 * non-derived tables are dropped; the read-path caches are kept, because
 * whether they belong in a comparison depends on what is being compared.
 */
export async function snapshotSpaceDb(
  spaceDb: DbLike,
): Promise<TableSnapshot[]> {
  const tables = await spaceDb
    .query(
      `select name from sqlite_master
        where type = 'table' and name not like 'sqlite_%'
        order by name`,
    )
    .all<{ name: string }>();

  const out: TableSnapshot[] = [];
  for (const { name } of tables) {
    if (NON_DERIVED_TABLES[name]) continue;
    const info = await spaceDb
      .query(`select name from pragma_table_info('${name}')`)
      .all<{ name: string }>();
    const columns = info
      .map((c) => c.name)
      .filter((c) => !CLOCK_COLUMNS[c]);
    const read = await spaceDb
      .query(`select ${columns.map((c) => `"${c}"`).join(", ")} from "${name}"`)
      .all<Record<string, unknown>>();
    out.push({
      table: name,
      columns,
      rows: canonicalRows(read.map((r) => Object.values(r))),
    });
  }
  return out;
}

/**
 * The tables `before` and `after` disagree on, by name and rows.
 *
 * The two readings may come from any two derivations — two runs of the TS
 * materialiser, or one TS run and one Rust run. A table present on only one
 * side is a divergence, reported with an empty row list on the missing side.
 * Rows are put in canonical order first, so a reading does not have to be
 * sorted by whoever produced it.
 */
export function diffSnapshots(
  before: TableSnapshot[],
  after: TableSnapshot[],
  ignoredTables: Iterable<string> = [],
): TableDivergence[] {
  const ignored = new Set(ignoredTables);
  const afterByTable = new Map(after.map((t) => [t.table, t]));
  const diverging: TableDivergence[] = [];
  const compared = new Set<string>();

  for (const table of before) {
    if (ignored.has(table.table)) continue;
    compared.add(table.table);
    const other = afterByTable.get(table.table);
    const reading = canonicalRows(table.rows).map(encodeRow).join("\n");
    if (other && canonicalRows(other.rows).map(encodeRow).join("\n") === reading) {
      continue;
    }
    diverging.push({
      table: table.table,
      before: table.rows,
      after: other?.rows ?? [],
    });
  }

  for (const table of after) {
    if (ignored.has(table.table) || compared.has(table.table)) continue;
    diverging.push({ table: table.table, before: [], after: table.rows });
  }

  return diverging;
}

/**
 * SHA-256 over a snapshot, in the canonical encoding defined at `encodeRow`:
 *
 *   for each table, in ascending table-name order:
 *     table name, ":", JSON array of the columns, "\n",
 *     then one line per row, each line the JSON array of the row's values.
 *
 * Both the tables and the rows are put in canonical order first, so the digest
 * depends on the rows a reading holds and not on the order they were read in —
 * a caller that built a snapshot by hand, or read one from another
 * implementation, does not have to sort it. A table with no rows contributes its
 * name and columns and nothing else.
 */
export function digestOf(tables: TableSnapshot[]): string {
  const hash = createHash("sha256");
  for (const table of [...tables].sort((a, b) =>
    a.table < b.table ? -1 : a.table > b.table ? 1 : 0,
  )) {
    hash.update(`${table.table}:${JSON.stringify(table.columns)}\n`);
    for (const row of canonicalRows(table.rows)) {
      hash.update(`${encodeRow(row)}\n`);
    }
  }
  return hash.digest("hex");
}

/**
 * Derive `streamDid`'s per-space state from its event log, through the path the
 * boot pass uses.
 *
 * The pass hydrates nothing: profiles are resolved at read time from the global
 * `profiles` table, so materialisation makes no outbound request
 * (`recordFetchCalls` pins that). A profile missing from the store renders as a
 * bare author until a read fills it; the global profile store is not per-space
 * state, so it is outside what this oracle compares.
 */
export async function materialiseFromLog(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  await reMaterializeFromLocalEvents(db, 1);
}

/**
 * Stamp `streamDid`'s canonical DB with a version this build cannot start from,
 * so the next `materialiseFromLog` takes the blue-green rebuild path: replay the
 * whole log into a fresh `.sqlite.new` DB and swap it in.
 */
export async function staleCanonicalDb(
  db: DbLike,
  streamDid: StreamDid,
): Promise<void> {
  const handle = db.forSpace?.(streamDid);
  if (!handle) {
    throw new Error(
      `rebuildEquality: the DB handle exposes no per-space DB for ${streamDid}`,
    );
  }
  await handle.run("update space_schema_version set version = '0' where id = 1");
}

/**
 * The composed check: snapshot the canonical DB, rebuild the space from the log
 * into a fresh DB, snapshot again, and name the tables that changed.
 *
 * `diverging` empty is the pass. When it is not, each entry carries both
 * readings of the table — usually enough to see what the derivations disagreed
 * about without re-running anything.
 */
export async function materialiseAndDiff(
  db: DbLike,
  streamDid: StreamDid,
  opts: MaterialiseAndDiffOpts = {},
): Promise<RebuildEquality> {
  const handle = db.forSpace?.(streamDid);
  if (!handle) {
    throw new Error(
      `rebuildEquality: the DB handle exposes no per-space DB for ${streamDid}`,
    );
  }
  const before = opts.before ?? (await snapshotSpaceDb(handle));
  await staleCanonicalDb(db, streamDid);
  await materialiseFromLog(db, streamDid);
  const after = await snapshotSpaceDb(handle);
  return {
    before,
    after,
    diverging: diffSnapshots(before, after, opts.ignoredTables),
  };
}

/**
 * Run `run` with `globalThis.fetch` replaced by a recorder that refuses the
 * request, and report what it refused.
 *
 * Materialisation is a function of the log, so it must not reach the network
 * (plan §6 P5, Step 5's acceptance). The stub rejects rather than returning a
 * synthetic response: a call materialisation is not supposed to make becomes an
 * attributable error at the call site, not a silently-empty result. The real
 * `fetch` is restored before this returns, thrown or not.
 */
export async function recordFetchCalls<T>(
  run: () => Promise<T>,
): Promise<{ result: T; calls: FetchCall[] }> {
  const real = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    calls.push({ url, method });
    return Promise.reject(
      new Error(`outbound request during materialisation: ${method} ${url}`),
    );
  }) as typeof globalThis.fetch;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    globalThis.fetch = real;
  }
}

/**
 * Rows in canonical order: by their encoding, so two readings that hold the
 * same rows in a different physical order compare equal.
 */
function canonicalRows(rows: unknown[][]): unknown[][] {
  return rows
    .map((row) => ({ row, key: encodeRow(row) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.row);
}

/**
 * A row's canonical encoding: its values as a JSON array.
 *
 * A value encodes as a JSON null, number, string or boolean; a blob as
 * `{"$bytes":"<base64>"}`; an integer outside the JSON number range as
 * `{"$bigint":"<decimal>"}`. Any other type is a value SQLite cannot hold,
 * which is a bug in the reader rather than a divergence to report.
 */
function encodeRow(row: unknown[]): string {
  return JSON.stringify(
    row.map((value) => {
      if (value instanceof Uint8Array) {
        return { $bytes: Buffer.from(value).toString("base64") };
      }
      if (typeof value === "bigint") return { $bigint: value.toString() };
      if (
        value === null ||
        typeof value === "number" ||
        typeof value === "string" ||
        typeof value === "boolean"
      ) {
        return value;
      }
      throw new TypeError(
        `rebuildEquality: unsupported SQLite value ${typeof value}`,
      );
    }),
  );
}
