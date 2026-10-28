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

/** One space's classification and, when compared, what the comparison found. */
export interface SpaceDigest {
  space: string;
  status: SpaceStatus;
  /** Tables `diffSnapshots` named; empty unless `divergent`. */
  tables: string[];
  /** `materialization_cursor.materialized_to`; null when the row is absent. */
  tsCursor: number | null;
  /** `worker_cursor.idx`; null when the row is absent. */
  rustCursor: number | null;
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

/** One space's comparison. The events DB is open on the caller's side. */
async function digestSpace(
  space: string,
  opts: ShadowDigestOptions,
  events: DbLike,
): Promise<SpaceDigest> {
  const base: SpaceDigest = {
    space,
    status: "missing-ts",
    tables: [],
    tsCursor: null,
    rustCursor: null,
    tip: null,
    schemaVersion: null,
    tsDigest: null,
    rustDigest: null,
  };

  const tsPath = join(opts.tsDir, `${space}${SPACE_DB_SUFFIX}`);
  const rustPath = join(opts.rustDir, `${space}${SPACE_DB_SUFFIX}`);
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
    base.tsDigest = digestOf(tsSnapshot);
    base.rustDigest = digestOf(rustSnapshot);

    const diverging = diffSnapshots(tsSnapshot, rustSnapshot);
    return diverging.length === 0
      ? { ...base, status: "matching" }
      : {
          ...base,
          status: "divergent",
          tables: diverging.map((d) => d.table).sort(),
        };
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
      details.push(`tables: ${space.tables.join(", ")}`);
    }
    if (space.status === "behind-ts" || space.status === "behind-rust") {
      details.push(
        `ts=${space.tsCursor ?? "unset"} rust=${space.rustCursor ?? "unset"} tip=${space.tip ?? "unset"}`,
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
