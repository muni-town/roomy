/**
 * Generate the TS↔Rust parity fixtures.
 *
 * Each fixture is one log's change feed plus the digests of the two databases
 * the TypeScript materialiser produces from it:
 *
 *   crates/space-db/tests/fixtures/<id>/fixture.json
 *
 * The Rust test (`crates/space-db/tests/parity.rs`) reads the feed, applies it
 * through the Rust rules, and asserts its digests equal the recorded ones. The
 * comparison is `streams/rebuildEquality.ts`'s: the same column order, the same
 * dropped clock columns, the same canonical row order and encoding, minus the
 * cursor tables and columns each implementation owns (`workerSnapshot`).
 *
 * Deterministic by construction: ids are minted from a counter at a fixed
 * instant, so re-running regenerates byte-identical files.
 *
 * Usage:
 *   bun run scripts/export-worker-fixtures.ts [--out <dir>]
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { encodeTime } from "ulidx";

import { closeDb, openDb } from "../src/db/db.ts";
import { toAsyncDb } from "../src/db/syncAdapter.ts";
import { applyBatch } from "../src/materialization/applyBatch.ts";
import {
  CORPUS_RECEIVED_AT,
  CORPUS_STREAM,
  buildCorpus,
} from "../src/materialization/records/corpus.ts";
import {
  GLOBAL_TABLES as GLOBAL_TABLES_FROM_MANIFEST,
  clockColumnsFor,
  digestOf,
  snapshotSpaceDb,
  workerSnapshot,
  type TableSnapshot,
} from "../src/streams/rebuildEquality.ts";
import {
  readRecordChanges,
  writeRecordChanges,
} from "../src/streams/recordChanges.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

const args = process.argv.slice(2);
const outDir = args.includes("--out")
  ? args[args.indexOf("--out") + 1]!
  : join(repoRoot, "crates", "space-db", "tests", "fixtures");

/** The instant every fixture ULID is minted at, so ids never move. */
const FIXED_ULID_TIME = 1_700_000_000_000;

/**
 * The exclusions and the compared global tables come from the one manifest the
 * oracle, the Rust digest and this exporter share
 * (`src/db/oracle-exclusions.json`).
 */
const GLOBAL_TABLES: readonly string[] = GLOBAL_TABLES_FROM_MANIFEST;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: number, len: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < len; i++) {
    out = CROCKFORD[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** A counter-minted ULID: fixed time, so the corpus is the same every run. */
function idSource(): () => string {
  let n = 0;
  return () => encodeTime(FIXED_ULID_TIME, 10) + encodeBase32(++n, 16);
}

async function globalSnapshot(db: Database): Promise<TableSnapshot[]> {
  const out: TableSnapshot[] = [];
  for (const table of GLOBAL_TABLES) {
    const info = db
      .query<{ name: string }, []>(`select name from pragma_table_info('${table}')`)
      .all();
    const dropped = clockColumnsFor(table);
    const columns = info.map((c) => c.name).filter((c) => !dropped[c]);
    const rows = db
      .query<Record<string, unknown>, []>(
        `select ${columns.map((c) => `"${c}"`).join(", ")} from "${table}"`,
      )
      .all();
    out.push({
      table,
      columns,
      rows: rows.map((row) => Object.values(row)),
    });
  }
  return out;
}

async function writeFixture(id: string): Promise<{
  events: number;
  changes: number;
  spaceDigest: string;
  globalDigest: string;
}> {
  const { entries } = buildCorpus({
    ids: idSource(),
    receivedAt: CORPUS_RECEIVED_AT,
    recordProducingOnly: true,
  });

  // The feed, written the way the write path writes it.
  const eventsRaw = new Database(":memory:");
  eventsRaw.exec(
    (await Bun.file(
      join(__dirname, "..", "src", "db", "eventsSchema.sql"),
    ).text()),
  );
  const events = toAsyncDb(eventsRaw);
  await writeRecordChanges(events, CORPUS_STREAM, entries);
  const changes = await readRecordChanges(
    events,
    CORPUS_STREAM,
    0,
    Number.MAX_SAFE_INTEGER,
  );

  // The projection the TypeScript materialiser produces from the same log.
  const spaceRaw = new Database(":memory:");
  spaceRaw.exec("pragma foreign_keys = on");
  spaceRaw.exec(
    (await Bun.file(
      join(__dirname, "..", "src", "db", "schema-space.sql"),
    ).text()),
  );
  // The pre-materialisation rows a space has before its first event: stamped
  // with the fixture's receipt instant, so the projection is reproducible.
  spaceRaw.run(
    "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, ?, ?)",
    [CORPUS_STREAM, CORPUS_STREAM, CORPUS_RECEIVED_AT, CORPUS_RECEIVED_AT],
  );
  spaceRaw.run(
    "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
    [CORPUS_STREAM, CORPUS_RECEIVED_AT, CORPUS_RECEIVED_AT],
  );

  const globalRaw = new Database(":memory:");
  globalRaw.exec("pragma foreign_keys = on");
  globalRaw.exec(
    (await Bun.file(
      join(__dirname, "..", "src", "db", "schema-global.sql"),
    ).text()),
  );

  const stats = await applyBatch(
    toAsyncDb(spaceRaw),
    CORPUS_STREAM,
    entries,
    { isBackfill: false },
    toAsyncDb(globalRaw),
  );
  if (stats.applyErrors > 0 || stats.materializerErrors > 0) {
    throw new Error(
      `fixture ${id}: ${stats.applyErrors} apply / ${stats.materializerErrors} materialiser errors`,
    );
  }

  if (process.env.ROOMY_DUMP_SNAPSHOT) {
    writeFileSync(
      process.env.ROOMY_DUMP_SNAPSHOT,
      JSON.stringify(workerSnapshot(await snapshotSpaceDb(toAsyncDb(spaceRaw))), null, 1),
    );
  }
  const spaceDigest = digestOf(
    workerSnapshot(await snapshotSpaceDb(toAsyncDb(spaceRaw))),
  );
  const globalDigest = digestOf(await globalSnapshot(globalRaw));

  const dir = join(outDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fixture.json"),
    `${JSON.stringify(
      {
        $comment:
          "Generated by packages/appserver/scripts/export-worker-fixtures.ts. Do not edit: re-run the script instead.",
        stream: CORPUS_STREAM,
        receivedAt: CORPUS_RECEIVED_AT,
        spaceSeed: {
          entities: [[CORPUS_STREAM, CORPUS_STREAM]],
          compSpace: [[CORPUS_STREAM]],
        },
        globalTables: GLOBAL_TABLES,
        counts: { events: entries.length, changes: changes.length },
        expected: { spaceDigest, globalDigest },
        changes,
      },
      null,
      2,
    )}\n`,
  );

  eventsRaw.close();
  spaceRaw.close();
  globalRaw.close();
  return {
    events: entries.length,
    changes: changes.length,
    spaceDigest,
    globalDigest,
  };
}

// `applyBatch`'s side-effect path opens the read-state DB through the worker.
openDb({ path: ":memory:" });
rmSync(outDir, { recursive: true, force: true });
const written = await writeFixture("registry-corpus");
closeDb();

process.stdout.write(
  `${written.events} events, ${written.changes} changes\n` +
    `space digest  ${written.spaceDigest}\n` +
    `global digest ${written.globalDigest}\n` +
    `written to ${outDir}\n`,
);
