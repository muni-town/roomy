/**
 * Shadow digest: does a shadow follower's projection match production's?
 *
 * A shadow deployment runs a second implementation of per-space materialisation
 * from the same log. Whether it agrees is a per-space DB diff, and the oracle
 * already exists: `snapshotSpaceDb` / `diffSnapshots` / `digestOf` in
 * `src/streams/rebuildEquality.ts`, with the exclusion manifest
 * (`src/db/oracle-exclusions.json`) the Rust side consumes too. This script is
 * the job that runs that oracle against live database files and reports.
 *
 * Usage:
 *
 *   bun run scripts/shadow-digest.ts \
 *     --ts-dir /data/spaces \
 *     --rust-dir /shadow/spaces \
 *     --events /data/roomy-events.sqlite \
 *     [--space <did> …] [--out /shadow/digest.json] [--json]
 *
 * **Eligibility.** A comparison is only valid when both projections applied the
 * same log prefix on the same schema version, so each space is classified
 * before anything is compared:
 *
 *   - TS cursor     `materialization_cursor.materialized_to` in the TS DB
 *   - Rust cursor   `worker_cursor.idx` in the shadow DB
 *   - log tip       `max(idx)` in `record_changes` for the space's stream
 *   - schema        `space_schema_version` in the TS DB versus
 *                   `SPACE_SCHEMA_VERSION`
 *
 * Two implementations own separate cursors in their own DBs; neither writes the
 * other. A space mid blue-green rebuild serves its old-schema canonical DB while
 * the `.sqlite.new` replay runs, so it is `schema-stale` and skipped, never
 * reported as divergent.
 *
 * **What is compared.** Every derived table in the per-space schema, minus the
 * entries in {@link IGNORED_TABLES}: tables the two cores maintain differently
 * by construction, each with its reason stated in that constant. `comp_embed_*`
 * and `comp_info` are deliberately *not* ignored — the enrichment sweeper
 * writes them outside the log, but that is a hypothesis about a divergence, not
 * grounds for hiding it, so they are compared and reported like any other table.
 *
 * **Evidence.** A divergent table carries the row count on each side and the
 * first row the two sides disagree on: its primary key, the columns that
 * differ, both values truncated to 80 characters, a blob reported as its size.
 * A table name alone has already been read as a finding when it was noise.
 *
 * **Clock skew.** A row's `created_at`/`updated_at` record when it was
 * written. The production write path stamps them with the wall clock; a
 * rebuild stamps them from the change's place in the log, and no replay can
 * recover the second a historical row was written. A divergent table whose
 * rows are equal once those columns are dropped is therefore `clock-only`; any
 * other divergence is `content`. Both are still compared and still count as a
 * divergence, but the summary leads with `content` tables because `clock-only`
 * ones cannot be fixed by the shadow.
 *
 * **Why a space was not compared.** Every report says whether the shadow DB
 * file exists, so "the worker applied no feed rows" (`rustCursor: null`,
 * `rustDbPresent: true`) reads differently from "the shadow never created the
 * DB" (`rustDbPresent: false`) without a second query.
 *
 * **Read-only.** Every file is opened with `{ readonly: true }`, so SQLite
 * refuses any write on the handle. Neither DB nor the events DB is ever written:
 * no cursor, no planner stats, no snapshot table. A readonly handle on a live
 * WAL database reads the committed prefix through the existing `-wal`/`-shm`
 * files.
 *
 * **Exit codes.** 0 when every eligible space matches; 1 when any space is
 * `divergent`; 2 when the run is not informative — no space could be compared,
 * or the events DB is unreadable. A green exit therefore always means at least
 * one space was compared and agreed.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { SPACE_SCHEMA_VERSION } from "../src/db/spaceVersions.ts";
import { toAsyncDb } from "../src/db/syncAdapter.ts";
import type { DbLike } from "../src/db/types.ts";
import {
  diffSnapshots,
  digestOf,
  snapshotSpaceDb,
  workerSnapshot,
  type TableDivergence,
  type TableSnapshot,
} from "../src/streams/rebuildEquality.ts";

/** How one space's two projections relate. */
export type SpaceStatus =
  | "matching"
  | "divergent"
  | "behind-ts"
  | "behind-rust"
  | "schema-stale"
  | "missing-rust"
  | "missing-ts";

/** One table the digest leaves out, and why the two cores may differ on it. */
export interface IgnoredTable {
  /** Exact table name, or a prefix ending in `*` (FTS5 shadow tables). */
  match: string;
  /** Why the log does not make the two sides agree here. */
  reason: string;
}

/** One column's values on each side of a divergent row, as reported. */
export interface ColumnDifference {
  column: string;
  /** The TS projection's value, presented (see `presented`). */
  ts: string;
  /** The shadow projection's value, presented. */
  rust: string;
}

/** The first row two projections disagree on, and how they disagree. */
export interface RowDifference {
  /** Primary-key columns of that row; empty when the table declares no key. */
  key: Record<string, string>;
  /**
   * Columns that differ. A row present on one side only lists every column,
   * with `(no row)` on the side that lacks it.
   */
  columns: ColumnDifference[];
}

/** One table the two projections disagree on, with the evidence. */
export interface TableDifference {
  table: string;
  /** Rows on the TS side. */
  tsRows: number;
  /** Rows on the shadow side. */
  rustRows: number;
  /**
   * What the two sides disagree on: `clock-only` when they differ only in
   * `created_at`/`updated_at`, `content` otherwise.
   */
  kind: DifferenceKind;
  /** The first differing row, in canonical order; null if none could be paired. */
  example: RowDifference | null;
}

/**
 * What a divergent table differs in. `clock-only` means every column that
 * differs is one of `WALL_CLOCK_COLUMNS`; `content` means a value the log
 * determines differs, a row exists on one side only, or the two sides declare
 * different columns.
 */
export type DifferenceKind = "content" | "clock-only";

/** One space's classification and, when compared, what the comparison found. */
export interface SpaceDigest {
  space: string;
  status: SpaceStatus;
  /** Tables the two projections disagree on; empty unless `divergent`. */
  divergences: TableDifference[];
  /** `materialization_cursor.materialized_to`; null when the row is absent. */
  tsCursor: number | null;
  /** `worker_cursor.idx`; null when the row is absent. */
  rustCursor: number | null;
  /** Whether the shadow's DB file exists at all. */
  rustDbPresent: boolean;
  /** `max(idx)` in `record_changes` for this stream; null when no changes exist. */
  tip: number | null;
  /** `space_schema_version.version` in the TS DB, when it could be read. */
  schemaVersion: string | null;
  tsDigest: string | null;
  rustDigest: string | null;
  /** Why the space could not be read, when it could not. */
  error?: string;
}

export interface ShadowDigestTotals {
  spaces: number;
  compared: number;
  matching: number;
  divergent: number;
  behind: number;
  schemaStale: number;
  missing: number;
}

export interface ShadowDigestReport {
  schemaVersion: string;
  tsDir: string;
  rustDir: string;
  events: string;
  totals: ShadowDigestTotals;
  spaces: SpaceDigest[];
  /** Set when the events DB could not be used, which makes the run uninformative. */
  error?: string;
}

export interface ShadowDigestOptions {
  tsDir: string;
  rustDir: string;
  eventsPath: string;
  /** Compare only these spaces. Omitted: every space DB file in either dir. */
  spaces?: readonly string[];
}

const SPACE_DB_SUFFIX = ".sqlite";

/**
 * A read-only handle on one database file.
 *
 * `toAsyncDb` only wraps a `Database`, and `readonly: true` is the narrowest way
 * to say "the job may not write": SQLite rejects every statement that would
 * modify the file, so the guarantee is the handle's, not the caller's.
 */
export function openReadOnlyDb(path: string): Database {
  return new Database(path, { readonly: true });
}

/** Space DBs present in `dir`, by space DID. Missing dirs and other files are skipped. */
export function spaceDidsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(SPACE_DB_SUFFIX)) continue;
    out.push(entry.name.slice(0, -SPACE_DB_SUFFIX.length));
  }
  return out.sort();
}

/**
 * Tables the digest leaves out of the comparison, each for a reason the two
 * cores' schemas make structural. Deliberately small: a table listed here is a
 * table nothing checks, so an entry has to say why the log cannot make the two
 * sides agree.
 *
 * The enrichment tables (`comp_embed_*`, `comp_info`) are absent on purpose.
 * The sweeper writes them outside the log, which *may* explain a divergence,
 * but a hypothesis is not a reason to hide the evidence.
 */
export const IGNORED_TABLES: readonly IgnoredTable[] = [
  {
    match: "message_fts*",
    reason:
      "full-text search stays in TypeScript (Rust core plan §10): the TS DB fills the FTS index and the shadow tables SQLite derives beside it, the Rust DB declares them and leaves them empty, so every space with a message differs here by construction",
  },
  {
    match: "room_access",
    reason:
      "a documented read-path cache (READ_PATH_CACHES in src/streams/rebuildEquality.ts): reads warm it and materialisation does not, so it records which reads each side served rather than the log",
  },
  {
    match: "room_activity",
    reason:
      "a documented read-path cache (READ_PATH_CACHES in src/streams/rebuildEquality.ts): maintained by live writes and reads and left empty by a rebuild, so it records traffic rather than the log prefix",
  },
];

/** Whether `table` is covered by an {@link IGNORED_TABLES} entry. */
export function isIgnoredTable(table: string): boolean {
  return IGNORED_TABLES.some(({ match }) =>
    match.endsWith("*") ? table.startsWith(match.slice(0, -1)) : table === match,
  );
}

/** The ignored tables these readings contain, by exact name. */
function ignoredNamesIn(...snapshots: readonly TableSnapshot[][]): string[] {
  const names = new Set<string>();
  for (const snapshot of snapshots) {
    for (const { table } of snapshot) {
      if (isIgnoredTable(table)) names.add(table);
    }
  }
  return [...names];
}

/** The longest value the report quotes from a row. */
export const VALUE_LIMIT = 80;
const ABSENT_ROW = "(no row)";
const ABSENT_COLUMN = "(no column)";

/** A column the other side's schema does not declare. */
const NO_COLUMN = Symbol("no column");

/**
 * The columns that record when a row was written rather than what it holds.
 * Dropping them from both readings and comparing again tells a disagreement
 * about history (the TS write path stamps the wall clock, a rebuild stamps the
 * log's time) apart from one about state.
 */
const WALL_CLOCK_COLUMNS: Readonly<Record<string, true>> = {
  created_at: true,
  updated_at: true,
};

/** A value's exact form, for comparing rows and pairing them by key. */
function encoded(value: unknown): string {
  if (value === NO_COLUMN) return "\u0000absent";
  if (value instanceof Uint8Array) {
    return `\u0000blob:${Buffer.from(value).toString("base64")}`;
  }
  if (typeof value === "bigint") return `\u0000bigint:${value.toString()}`;
  return JSON.stringify(value) ?? "\u0000null";
}

/**
 * A value as the report shows it: text truncated to `VALUE_LIMIT` characters,
 * a blob as its size. The bytes of a blob are never quoted — a page's content
 * or an image's payload would swamp the report and leak user data into logs.
 */
function presented(value: unknown): string {
  if (value === NO_COLUMN) return ABSENT_COLUMN;
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `blob(${value.byteLength} B)`;
  const text = typeof value === "bigint" ? value.toString() : String(value);
  return text.length <= VALUE_LIMIT
    ? text
    : `${text.slice(0, VALUE_LIMIT - 1)}…`;
}

/** The columns either side declares, TS order first. */
function unionColumns(
  ts: readonly string[],
  rust: readonly string[],
): string[] {
  const union = [...ts];
  for (const column of rust) if (!union.includes(column)) union.push(column);
  return union;
}

/** `rows` re-read against `union`, with `NO_COLUMN` where a column is absent. */
function unionRows(
  rows: readonly unknown[][],
  from: readonly string[],
  union: readonly string[],
): unknown[][] {
  const indexes = union.map((column) => from.indexOf(column));
  return rows.map((row) =>
    indexes.map((index) => (index === -1 ? NO_COLUMN : row[index])),
  );
}

/** Rows in the canonical order the digest compares in. */
function canonicalOrder(rows: readonly unknown[][]): unknown[][] {
  return rows
    .map((row) => ({ row, key: row.map(encoded).join("\u0000") }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.row);
}

/**
 * Indexes of `table`'s primary-key columns in `union`, in key order.
 *
 * Read from whichever DB declares the table. A key column the snapshot dropped
 * leaves the table without a usable key, and the example falls back to
 * comparing rows positionally.
 */
async function primaryKeyIndexes(
  dbs: readonly DbLike[],
  table: string,
  union: readonly string[],
): Promise<number[]> {
  const quoted = table.replace(/'/g, "''");
  for (const db of dbs) {
    let info: { name: string; pk: number }[];
    try {
      info = await db
        .query(`select name, pk from pragma_table_info('${quoted}')`)
        .all<{ name: string; pk: number }>();
    } catch {
      continue;
    }
    if (info.length === 0) continue;
    const names = info
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    const indexes = names.map((name) => union.indexOf(name));
    return indexes.length > 0 && indexes.every((index) => index >= 0)
      ? indexes
      : [];
  }
  return [];
}

function keyRecord(
  row: readonly unknown[],
  union: readonly string[],
  keyIndexes: readonly number[],
): Record<string, string> {
  const key: Record<string, string> = {};
  for (const index of keyIndexes) key[union[index]!] = presented(row[index]);
  return key;
}

function differingColumns(
  ts: readonly unknown[],
  rust: readonly unknown[],
  union: readonly string[],
): ColumnDifference[] {
  const out: ColumnDifference[] = [];
  for (let i = 0; i < union.length; i++) {
    if (encoded(ts[i]) === encoded(rust[i])) continue;
    out.push({
      column: union[i]!,
      ts: presented(ts[i]),
      rust: presented(rust[i]),
    });
  }
  return out;
}

/** A row only one side holds; every column is reported against `(no row)`. */
function oneSidedExample(
  row: readonly unknown[],
  union: readonly string[],
  keyIndexes: readonly number[],
  side: "ts" | "rust",
): RowDifference {
  return {
    key: keyRecord(row, union, keyIndexes),
    columns: union.map((column, i) => ({
      column,
      ts: side === "ts" ? presented(row[i]) : ABSENT_ROW,
      rust: side === "rust" ? presented(row[i]) : ABSENT_ROW,
    })),
  };
}

function keyedExample(
  ts: readonly unknown[][],
  rust: readonly unknown[][],
  union: readonly string[],
  keyIndexes: readonly number[],
): RowDifference | null {
  const keyOf = (row: readonly unknown[]) =>
    keyIndexes.map((index) => encoded(row[index])).join("\u0001");
  const rustByKey = new Map<string, unknown[]>();
  for (const row of rust) {
    const key = keyOf(row);
    if (!rustByKey.has(key)) rustByKey.set(key, row);
  }
  const tsKeys = new Set(ts.map(keyOf));

  for (const row of ts) {
    const other = rustByKey.get(keyOf(row));
    if (other === undefined) return oneSidedExample(row, union, keyIndexes, "ts");
    const columns = differingColumns(row, other, union);
    if (columns.length > 0) {
      return { key: keyRecord(row, union, keyIndexes), columns };
    }
  }
  for (const row of rust) {
    if (!tsKeys.has(keyOf(row))) {
      return oneSidedExample(row, union, keyIndexes, "rust");
    }
  }
  return null;
}

function positionalExample(
  ts: readonly unknown[][],
  rust: readonly unknown[][],
  union: readonly string[],
): RowDifference | null {
  for (let i = 0; i < Math.max(ts.length, rust.length); i++) {
    const a = ts[i];
    const b = rust[i];
    if (a === undefined) return oneSidedExample(b!, union, [], "rust");
    if (b === undefined) return oneSidedExample(a, union, [], "ts");
    const columns = differingColumns(a, b, union);
    if (columns.length > 0) return { key: {}, columns };
  }
  return null;
}

/**
 * Whether two readings of a divergent table disagree only on their wall-clock
 * columns: equal once `created_at` and `updated_at` are dropped. A reading
 * that declares different columns at all is content, and so is a row held on
 * one side only.
 */
function differenceKind(
  divergence: TableDivergence,
  union: readonly string[],
  tsColumns: readonly string[],
  rustColumns: readonly string[],
): DifferenceKind {
  if (
    tsColumns.length !== rustColumns.length ||
    tsColumns.some((column) => !rustColumns.includes(column))
  ) {
    return "content";
  }
  const keep = union
    .map((column, index) => (WALL_CLOCK_COLUMNS[column] ? -1 : index))
    .filter((index) => index >= 0);
  const readings: string[] = [];
  for (const [rows, columns] of [
    [divergence.before, tsColumns],
    [divergence.after, rustColumns],
  ] as const) {
    readings.push(
      canonicalOrder(
        unionRows(rows, columns, union).map((row) =>
          keep.map((index) => row[index]),
        ),
      )
        .map((row) => row.map(encoded).join("\u0000"))
        .join("\u0001"),
    );
  }
  return readings[0] === readings[1] ? "clock-only" : "content";
}

/** One diverging table, with the evidence a table name alone cannot carry. */
function compareRows(
  divergence: TableDivergence,
  union: readonly string[],
  keyIndexes: readonly number[],
  tsColumns: readonly string[],
  rustColumns: readonly string[],
): TableDifference {
  const ts = canonicalOrder(unionRows(divergence.before, tsColumns, union));
  const rust = canonicalOrder(unionRows(divergence.after, rustColumns, union));
  return {
    table: divergence.table,
    kind: differenceKind(divergence, union, tsColumns, rustColumns),
    tsRows: divergence.before.length,
    rustRows: divergence.after.length,
    example:
      keyIndexes.length === 0
        ? positionalExample(ts, rust, union)
        : keyedExample(ts, rust, union, keyIndexes),
  };
}

/** One space's comparison. The events DB is open on the caller's side. */
async function digestSpace(
  space: string,
  opts: ShadowDigestOptions,
  events: DbLike,
): Promise<SpaceDigest> {
  const base: SpaceDigest = {
    space,
    status: "missing-ts",
    divergences: [],
    tsCursor: null,
    rustCursor: null,
    rustDbPresent: false,
    tip: null,
    schemaVersion: null,
    tsDigest: null,
    rustDigest: null,
  };

  const tsPath = join(opts.tsDir, `${space}${SPACE_DB_SUFFIX}`);
  const rustPath = join(opts.rustDir, `${space}${SPACE_DB_SUFFIX}`);
  base.rustDbPresent = existsSync(rustPath);
  const tipRow = await events
    .query("select max(idx) as idx from record_changes where stream_id = ?")
    .get<{ idx: number | null }>([space]);
  base.tip = tipRow?.idx ?? null;

  let tsDb: Database;
  try {
    tsDb = openReadOnlyDb(tsPath);
  } catch (err) {
    if (!existsSync(tsPath)) return { ...base, status: "missing-ts" };
    return { ...base, status: "missing-ts", error: message(err) };
  }

  let rustDb: Database | null = null;
  // Which side the current read belongs to, so a corrupt file is reported as
  // that side being unusable rather than as the other one being absent.
  let reading: "ts" | "rust" = "ts";
  try {
    const ts = toAsyncDb(tsDb);
    base.tsCursor =
      (
        await ts
          .query(
            "select materialized_to from materialization_cursor where stream_id = ?",
          )
          .get<{ materialized_to: number }>([space])
      )?.materialized_to ?? null;
    base.schemaVersion =
      (
        await ts
          .query("select version from space_schema_version where id = 1")
          .get<{ version: string }>([])
      )?.version ?? null;

    if (base.schemaVersion !== SPACE_SCHEMA_VERSION) {
      return { ...base, status: "schema-stale" };
    }

    reading = "rust";
    try {
      rustDb = openReadOnlyDb(rustPath);
    } catch (err) {
      if (!existsSync(rustPath)) return { ...base, status: "missing-rust" };
      return { ...base, status: "missing-rust", error: message(err) };
    }
    const rust = toAsyncDb(rustDb);
    base.rustCursor =
      (
        await rust
          .query("select idx from worker_cursor where id = 1")
          .get<{ idx: number }>([])
      )?.idx ?? null;

    // Both projections must have applied the same log prefix. The TS side is
    // checked first: it is the reference the shadow follows, and a space where
    // both lag is not comparable for either reason.
    const tip = base.tip ?? -1;
    if ((base.tsCursor ?? -1) !== tip) {
      return { ...base, status: "behind-ts" };
    }
    if ((base.rustCursor ?? -1) !== tip) {
      return { ...base, status: "behind-rust" };
    }

    reading = "ts";
    const tsSnapshot = workerSnapshot(await snapshotSpaceDb(ts));
    reading = "rust";
    const rustSnapshot = workerSnapshot(await snapshotSpaceDb(rust));

    // The digests follow the comparison: a table the ignore list drops cannot
    // make two otherwise-equal projections look different.
    const ignored = ignoredNamesIn(tsSnapshot, rustSnapshot);
    const ignoredSet = new Set(ignored);
    const compared = (snapshot: TableSnapshot[]) =>
      snapshot.filter((table) => !ignoredSet.has(table.table));
    base.tsDigest = digestOf(compared(tsSnapshot));
    base.rustDigest = digestOf(compared(rustSnapshot));

    const diverging = diffSnapshots(tsSnapshot, rustSnapshot, ignored);
    if (diverging.length === 0) return { ...base, status: "matching" };

    const tsColumns = new Map(tsSnapshot.map((t) => [t.table, t.columns]));
    const rustColumns = new Map(rustSnapshot.map((t) => [t.table, t.columns]));
    const divergences: TableDifference[] = [];
    for (const divergence of diverging) {
      const union = unionColumns(
        tsColumns.get(divergence.table) ?? [],
        rustColumns.get(divergence.table) ?? [],
      );
      divergences.push(
        compareRows(
          divergence,
          union,
          await primaryKeyIndexes([ts, rust], divergence.table, union),
          tsColumns.get(divergence.table) ?? [],
          rustColumns.get(divergence.table) ?? [],
        ),
      );
    }
    return { ...base, status: "divergent", divergences };
  } catch (err) {
    return {
      ...base,
      status: reading === "ts" ? "missing-ts" : "missing-rust",
      error: message(err),
    };
  } finally {
    closeQuietly(tsDb);
    if (rustDb) closeQuietly(rustDb);
  }
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    /* best-effort: a handle that failed to open has nothing to close */
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function totalsOf(spaces: SpaceDigest[]): ShadowDigestTotals {
  const count = (predicate: (s: SpaceDigest) => boolean) =>
    spaces.filter(predicate).length;
  const matching = count((s) => s.status === "matching");
  const divergent = count((s) => s.status === "divergent");
  return {
    spaces: spaces.length,
    compared: matching + divergent,
    matching,
    divergent,
    behind: count((s) => s.status === "behind-ts" || s.status === "behind-rust"),
    schemaStale: count((s) => s.status === "schema-stale"),
    missing: count((s) => s.status === "missing-ts" || s.status === "missing-rust"),
  };
}

/**
 * The exit code the report earns. `2` is "this run proves nothing": either no
 * space could be compared, or the log the comparison is anchored to is
 * unreadable.
 */
export function exitCodeFor(report: ShadowDigestReport): 0 | 1 | 2 {
  if (report.error !== undefined) return 2;
  if (report.totals.divergent > 0) return 1;
  if (report.totals.compared === 0) return 2;
  return 0;
}

/** Run the comparison over every selected space. Read-only throughout. */
export async function runShadowDigest(
  opts: ShadowDigestOptions,
): Promise<{ report: ShadowDigestReport; exitCode: 0 | 1 | 2 }> {
  const selected =
    opts.spaces !== undefined && opts.spaces.length > 0
      ? [
          ...new Set(
            opts.spaces.map((space) =>
              space.endsWith(SPACE_DB_SUFFIX)
                ? space.slice(0, -SPACE_DB_SUFFIX.length)
                : space,
            ),
          ),
        ].sort()
      : [
          ...new Set([
            ...spaceDidsIn(opts.tsDir),
            ...spaceDidsIn(opts.rustDir),
          ]),
        ].sort();

  const report: ShadowDigestReport = {
    schemaVersion: SPACE_SCHEMA_VERSION,
    tsDir: opts.tsDir,
    rustDir: opts.rustDir,
    events: opts.eventsPath,
    totals: totalsOf([]),
    spaces: [],
  };

  let eventsDb: Database | null = null;
  try {
    eventsDb = openReadOnlyDb(opts.eventsPath);
    const events = toAsyncDb(eventsDb);
    const present = await events
      .query(
        "select count(*) as n from sqlite_master where type = 'table' and name = 'record_changes'",
      )
      .get<{ n: number }>([]);
    if (present?.n !== 1) {
      throw new Error("no record_changes table: not an events database");
    }

    const spaces: SpaceDigest[] = [];
    for (const space of selected) {
      spaces.push(await digestSpace(space, opts, events));
    }
    report.spaces = spaces;
    report.totals = totalsOf(spaces);
  } catch (err) {
    report.error = message(err);
  } finally {
    if (eventsDb !== null) closeQuietly(eventsDb);
  }

  return { report, exitCode: exitCodeFor(report) };
}

/** The human summary: totals, then one line per space that did not match. */
export function formatSummary(report: ShadowDigestReport): string {
  const t = report.totals;
  const lines = [
    `shadow digest: ${t.spaces} spaces, ${t.compared} compared ` +
      `(${t.matching} matching, ${t.divergent} divergent), ` +
      `${t.behind} behind, ${t.schemaStale} schema-stale, ${t.missing} missing`,
  ];
  if (report.error !== undefined) {
    lines.push(`error: ${report.error}`);
  }
  for (const space of report.spaces) {
    if (space.status === "matching") continue;
    const details: string[] = [];
    if (space.status === "divergent") {
      const content = space.divergences.filter(
        (difference) => difference.kind === "content",
      );
      const clockOnly = space.divergences.length - content.length;
      details.push(
        `${content.length} table${content.length === 1 ? "" : "s"} ` +
          `${content.length === 1 ? "differs" : "differ"} in content, ` +
          `${clockOnly} only in created_at/updated_at`,
      );
      if (content.length > 0) {
        details.push(content.map(formatDifference).join("; "));
      }
    }
    if (space.status === "behind-ts" || space.status === "behind-rust") {
      details.push(
        `ts=${space.tsCursor ?? "unset"} rust=${space.rustCursor ?? "unset"} ` +
          `tip=${space.tip ?? "unset"} rust-db=${space.rustDbPresent ? "present" : "absent"}`,
      );
    }
    if (space.status === "missing-ts" || space.status === "missing-rust") {
      details.push(
        `rust-db=${space.rustDbPresent ? "present" : "absent"}`,
      );
    }
    if (space.status === "schema-stale") {
      details.push(
        `schema=${space.schemaVersion ?? "unset"} expected=${report.schemaVersion}`,
      );
    }
    if (space.error !== undefined) details.push(space.error);
    lines.push(
      details.length === 0
        ? `${space.status} ${space.space}`
        : `${space.status} ${space.space}  ${details.join("  ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * One divergent table as prose: both counts, then the first differing row's
 * key and the columns that differ. The column list is capped so one wide row
 * does not turn into a paragraph; the JSON report keeps every column.
 */
function formatDifference(difference: TableDifference): string {
  const head =
    `${difference.table} ts=${difference.tsRows} rust=${difference.rustRows}`;
  const { example } = difference;
  if (example === null) return head;
  const key = Object.entries(example.key)
    .map(([column, value]) => `${column}=${value}`)
    .join(",");
  const shown = example.columns.slice(0, 6);
  const columns = shown
    .map((column) => `${column.column}: ts=${column.ts} rust=${column.rust}`)
    .join(", ");
  const more = example.columns.length - shown.length;
  return `${head} key=${key === "" ? "(none)" : key} differs: ${columns}${
    more > 0 ? ` (+${more} more columns)` : ""
  }`;
}

const USAGE =
  "usage: bun run scripts/shadow-digest.ts --ts-dir <dir> --rust-dir <dir> " +
  "--events <file> [--space <did>]… [--out <file>] [--json]";

export interface ParsedArgs {
  options: ShadowDigestOptions;
  out?: string;
  json: boolean;
}

export function parseShadowDigestArgs(
  argv: readonly string[],
): { ok: true; value: ParsedArgs } | { ok: false; error: string } {
  const values = new Map<string, string>();
  const spaces: string[] = [];
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      return { ok: false, error: `unexpected argument: ${arg}` };
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (
      ["--ts-dir", "--rust-dir", "--events", "--out", "--space"].includes(name)
    ) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "") {
        return { ok: false, error: `${name} needs a value` };
      }
      if (name === "--space") spaces.push(value);
      else values.set(name, value);
      continue;
    }
    return { ok: false, error: `unknown flag: ${name}` };
  }

  const tsDir = values.get("--ts-dir");
  const rustDir = values.get("--rust-dir");
  const eventsPath = values.get("--events");
  if (tsDir === undefined) return { ok: false, error: "--ts-dir is required" };
  if (rustDir === undefined) return { ok: false, error: "--rust-dir is required" };
  if (eventsPath === undefined) return { ok: false, error: "--events is required" };

  return {
    ok: true,
    value: {
      options: { tsDir, rustDir, eventsPath, spaces },
      out: values.get("--out"),
      json,
    },
  };
}

if (import.meta.main) {
  const parsed = parseShadowDigestArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const { report, exitCode } = await runShadowDigest(parsed.value.options);
    if (parsed.value.out !== undefined) {
      writeFileSync(parsed.value.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(
      parsed.value.json ? `${JSON.stringify(report, null, 2)}\n` : formatSummary(report),
    );
    process.exitCode = exitCode;
  }
}
