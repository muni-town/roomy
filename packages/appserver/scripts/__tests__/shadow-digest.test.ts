/**
 * The shadow digest job: does it classify two live projections correctly, and
 * does it prove it read them without writing?
 *
 * Each test builds real per-space DBs from the same log through `applyBatch`
 * (the write path), writes the change feed the worker would read
 * (`writeRecordChanges`), and points the job at them. The read-only test hashes
 * the files and the directory listings before and after a run.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { closeDb, openDb } from "../../src/db/db.ts";
import { SPACE_SCHEMA_VERSION } from "../../src/db/spaceVersions.ts";
import { toAsyncDb } from "../../src/db/syncAdapter.ts";
import { applyBatch } from "../../src/materialization/applyBatch.ts";
import {
  CORPUS_RECEIVED_AT,
  CORPUS_STREAM,
  buildCorpus,
} from "../../src/materialization/records/corpus.ts";
import type { LoggedEvent } from "../../src/materialization/types.ts";
import { writeRecordChanges } from "../../src/streams/recordChanges.ts";
import {
  formatSummary,
  openReadOnlyDb,
  parseShadowDigestArgs,
  runShadowDigest,
  type ShadowDigestReport,
} from "../shadow-digest.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "..", "src", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "src",
  "db",
  "schema-global.sql",
);
const EVENTS_SCHEMA_PATH = join(
  __dirname,
  "..",
  "..",
  "src",
  "db",
  "eventsSchema.sql",
);

const STREAM = CORPUS_STREAM;
const SEEDED_AT = CORPUS_RECEIVED_AT;

// One log, applied to every DB the tests build. `recordProducingOnly` keeps
// every entry in the feed, so the log tip is the last entry's idx.
const { entries } = buildCorpus({ recordProducingOnly: true });

let root: string;
let tsDir: string;
let rustDir: string;
let eventsPath: string;

beforeEach(() => {
  // `applyBatch`'s side-effect path opens the read-state DB through the worker.
  closeDb();
  openDb({ path: ":memory:" });
  root = mkdtempSync(join(tmpdir(), "shadow-digest-"));
  tsDir = join(root, "ts");
  rustDir = join(root, "rust");
  mkdirSync(tsDir);
  mkdirSync(rustDir);
  eventsPath = join(root, "roomy-events.sqlite");
});

afterEach(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

/** Write the change feed for the corpus and return the log tip. */
async function writeEvents(path: string): Promise<number> {
  const db = new Database(path);
  db.exec(readFileSync(EVENTS_SCHEMA_PATH, "utf8"));
  await writeRecordChanges(toAsyncDb(db), STREAM, entries);
  const row = db
    .query("select max(idx) as idx from record_changes where stream_id = ?")
    .get(STREAM) as { idx: number | null } | null;
  db.close();
  return row?.idx ?? -1;
}

/**
 * Build one per-space DB from the log, the way the write path does: the seed
 * rows, then `applyBatch`, which also advances `materialization_cursor` to the
 * last entry it applied.
 */
async function buildSpace(
  path: string,
  opts: { version?: string; log?: LoggedEvent[] } = {},
): Promise<void> {
  const db = new Database(path);
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  db.run("insert into space_schema_version (id, version) values (1, ?)", [
    opts.version ?? SPACE_SCHEMA_VERSION,
  ]);
  db.run(
    "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, ?, ?)",
    [STREAM, STREAM, SEEDED_AT, SEEDED_AT],
  );
  db.run(
    "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
    [STREAM, SEEDED_AT, SEEDED_AT],
  );

  const global = new Database(":memory:");
  global.exec(readFileSync(GLOBAL_SCHEMA_PATH, "utf8"));
  const stats = await applyBatch(
    toAsyncDb(db),
    STREAM,
    opts.log ?? entries,
    { isBackfill: false },
    toAsyncDb(global),
  );
  db.close();
  global.close();
  if (stats.applyErrors > 0 || stats.materializerErrors > 0) {
    throw new Error(
      `fixture: ${stats.applyErrors} apply / ${stats.materializerErrors} materialiser errors`,
    );
  }
}

/** Mark the shadow worker's progress, as its first committed batch would. */
function setWorkerCursor(path: string, idx: number): void {
  const db = new Database(path);
  db.run("insert into worker_cursor (id, idx, ord) values (1, ?, 0)", [idx]);
  db.close();
}

function spacePath(dir: string): string {
  return join(dir, `${STREAM}.sqlite`);
}

async function run(): Promise<{ report: ShadowDigestReport; exitCode: 0 | 1 | 2 }> {
  return runShadowDigest({ tsDir, rustDir, eventsPath });
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = hashFile(join(dir, name));
  }
  return out;
}

describe("a space both projections agree on", () => {
  test("is matching, with equal digests, and exits 0", async () => {
    const tip = await writeEvents(eventsPath);
    await buildSpace(spacePath(tsDir));
    await buildSpace(spacePath(rustDir));
    setWorkerCursor(spacePath(rustDir), tip);

    const { report, exitCode } = await run();

    expect(report.spaces).toHaveLength(1);
    const [space] = report.spaces;
    expect(space!.space).toBe(STREAM);
    expect(space!.status).toBe("matching");
    expect(space!.tables).toEqual([]);
    expect(space!.tsCursor).toBe(tip);
    expect(space!.rustCursor).toBe(tip);
    expect(space!.tip).toBe(tip);
    expect(space!.tsDigest).toBe(space!.rustDigest!);
    expect(report.totals).toEqual({
      spaces: 1,
      compared: 1,
      matching: 1,
      divergent: 0,
      behind: 0,
      schemaStale: 0,
      missing: 0,
    });
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe("a space the two projections disagree on", () => {
  test("is divergent, names the table, and exits 1", async () => {
    const tip = await writeEvents(eventsPath);
    await buildSpace(spacePath(tsDir));
    await buildSpace(spacePath(rustDir));
    setWorkerCursor(spacePath(rustDir), tip);

    // A derived row the shadow got wrong.
    const tampered = new Database(spacePath(rustDir));
    tampered.run("update comp_room set label = 'tampered'");
    tampered.close();

    const { report, exitCode } = await run();

    expect(report.spaces[0]!.status).toBe("divergent");
    expect(report.spaces[0]!.tables).toContain("comp_room");
    expect(report.totals.divergent).toBe(1);
    expect(report.totals.compared).toBe(1);
    expect(exitCode).toBe(1);
    expect(formatSummary(report)).toContain("comp_room");
  }, 30_000);
});

describe("eligibility", () => {
  test("a shadow behind the tip is behind-rust and not compared", async () => {
    const tip = await writeEvents(eventsPath);
    await buildSpace(spacePath(tsDir));
    await buildSpace(spacePath(rustDir));
    setWorkerCursor(spacePath(rustDir), tip - 1);

    const { report, exitCode } = await run();

    expect(report.spaces[0]!.status).toBe("behind-rust");
    expect(report.spaces[0]!.rustCursor).toBe(tip - 1);
    expect(report.spaces[0]!.tables).toEqual([]);
    expect(report.spaces[0]!.tsDigest).toBeNull();
    expect(report.totals).toEqual({
      spaces: 1,
      compared: 0,
      matching: 0,
      divergent: 0,
      behind: 1,
      schemaStale: 0,
      missing: 0,
    });
    // Nothing was compared, so the run proves nothing.
    expect(exitCode).toBe(2);
  }, 30_000);

  test("an old schema version is schema-stale and skipped", async () => {
    const tip = await writeEvents(eventsPath);
    await buildSpace(spacePath(tsDir), { version: "6" });
    await buildSpace(spacePath(rustDir));
    setWorkerCursor(spacePath(rustDir), tip);

    // Even a real divergence does not make a stale space comparable.
    const tampered = new Database(spacePath(rustDir));
    tampered.run("delete from comp_room");
    tampered.close();

    const { report, exitCode } = await run();

    expect(SPACE_SCHEMA_VERSION).not.toBe("6");
    expect(report.spaces[0]!.status).toBe("schema-stale");
    expect(report.spaces[0]!.schemaVersion).toBe("6");
    expect(report.totals.schemaStale).toBe(1);
    expect(report.totals.compared).toBe(0);
    expect(exitCode).toBe(2);
  }, 30_000);

  test("a file absent on one side is missing, not divergent", async () => {
    await writeEvents(eventsPath);
    await buildSpace(spacePath(tsDir));
    // The shadow has a different space, not this one.
    mkdirSync(join(root, "rust-only"));
    await buildSpace(join(root, "rust-only", "did:plc:elsewhere.sqlite"));

    const { report, exitCode } = await run();

    expect(report.spaces.map((s) => s.status)).toEqual(["missing-rust"]);
    expect(report.totals.missing).toBe(1);
    expect(exitCode).toBe(2);

    // Now the shadow has it and production does not.
    mkdirSync(join(root, "ts-empty"));
    const missingTs = await runShadowDigest({
      tsDir: join(root, "ts-empty"),
      rustDir: join(root, "rust-only"),
      eventsPath,
    });
    expect(missingTs.report.spaces[0]!.status).toBe("missing-ts");
    expect(missingTs.exitCode).toBe(2);
  }, 30_000);
});

describe("an uninformative run", () => {
  test("exits 2 when no space is eligible", async () => {
    const tip = await writeEvents(eventsPath);
    expect(tip).toBeGreaterThan(0);

    const { report, exitCode } = await run();

    expect(report.spaces).toEqual([]);
    expect(report.totals).toEqual({
      spaces: 0,
      compared: 0,
      matching: 0,
      divergent: 0,
      behind: 0,
      schemaStale: 0,
      missing: 0,
    });
    expect(report.error).toBeUndefined();
    expect(exitCode).toBe(2);
  }, 30_000);

  test("exits 2 when the events DB cannot be read", async () => {
    await buildSpace(spacePath(tsDir));
    await buildSpace(spacePath(rustDir));

    const { report, exitCode } = await runShadowDigest({
      tsDir,
      rustDir,
      eventsPath: join(root, "absent.sqlite"),
    });

    expect(report.error).toBeDefined();
    expect(report.spaces).toEqual([]);
    expect(exitCode).toBe(2);
  }, 30_000);

  test("exits 2 when the events file is not an events database", async () => {
    const bogus = new Database(eventsPath);
    bogus.exec("create table unrelated (id integer)");
    bogus.close();
    await buildSpace(spacePath(tsDir));
    await buildSpace(spacePath(rustDir));

    const { report, exitCode } = await run();

    expect(report.error).toContain("record_changes");
    expect(exitCode).toBe(2);
  }, 30_000);
});

describe("read-only", () => {
  test("a run leaves both DBs and the events DB byte-identical", async () => {
    const tip = await writeEvents(eventsPath);
    await buildSpace(spacePath(tsDir));
    await buildSpace(spacePath(rustDir));
    setWorkerCursor(spacePath(rustDir), tip);

    const tsBefore = snapshotFiles(tsDir);
    const rustBefore = snapshotFiles(rustDir);
    const eventsBefore = hashFile(eventsPath);

    const { report, exitCode } = await run();

    // The space was genuinely compared, so the run had to read both files.
    expect(report.spaces[0]!.status).toBe("matching");
    expect(exitCode).toBe(0);

    expect(snapshotFiles(tsDir)).toEqual(tsBefore);
    expect(snapshotFiles(rustDir)).toEqual(rustBefore);
    expect(hashFile(eventsPath)).toBe(eventsBefore);
    expect(existsSync(`${eventsPath}-wal`)).toBe(false);
    expect(existsSync(`${eventsPath}-shm`)).toBe(false);
    expect(existsSync(`${spacePath(tsDir)}-wal`)).toBe(false);
    expect(existsSync(`${spacePath(tsDir)}-shm`)).toBe(false);
  }, 30_000);

  test("the handle the job opens refuses writes", async () => {
    await buildSpace(spacePath(tsDir));

    const handle = openReadOnlyDb(spacePath(tsDir));
    expect(() => handle.run("update comp_space set hidden = 1")).toThrow(
      /readonly/i,
    );
    handle.close();
  }, 30_000);

  test("reads a live writer's WAL without touching the main DB or the -wal", async () => {
    // The job runs beside a writer, so the DBs it reads are WAL databases with
    // an open connection holding committed pages out of the main file.
    const SCHEMA = readFileSync(SCHEMA_PATH, "utf8");
    const open = (path: string, cursorSql: string): Database => {
      const db = new Database(path);
      db.exec("pragma journal_mode = wal");
      db.exec(SCHEMA);
      db.run("insert into space_schema_version (id, version) values (1, ?)", [
        SPACE_SCHEMA_VERSION,
      ]);
      db.run(
        "insert into entities (id, stream_id, created_at, updated_at) values (?, ?, ?, ?)",
        [STREAM, STREAM, SEEDED_AT, SEEDED_AT],
      );
      db.run(
        "insert into comp_space (entity, created_at, updated_at) values (?, ?, ?)",
        [STREAM, SEEDED_AT, SEEDED_AT],
      );
      db.run(cursorSql);
      return db;
    };
    const ts = open(
      spacePath(tsDir),
      `insert into materialization_cursor (stream_id, materialized_to) values ('${STREAM}', 5)`,
    );
    const rust = open(
      spacePath(rustDir),
      "insert into worker_cursor (id, idx, ord) values (1, 5, 0)",
    );
    const events = new Database(eventsPath);
    events.exec("pragma journal_mode = wal");
    events.exec(readFileSync(EVENTS_SCHEMA_PATH, "utf8"));
    events.run(
      `insert into record_changes
         (stream_id, idx, ord, kind, repo, collection, rkey, op,
          order_stamp, actor, event_id, body)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        STREAM,
        5,
        0,
        "space.roomy.room",
        "did:plc:author",
        "space.roomy.room",
        "rkey",
        "delete",
        "stamp",
        "did:plc:author",
        "event",
        null,
      ],
    );

    try {
      // Uncheckpointed pages: the main DB alone does not hold the projection.
      expect(existsSync(`${spacePath(tsDir)}-wal`)).toBe(true);
      const files = [spacePath(tsDir), spacePath(rustDir), eventsPath];
      const before = files.map(hashFile);
      const walBefore = files.map((path) => readFileSync(`${path}-wal`));
      const tsListing = readdirSync(tsDir).sort();
      const rustListing = readdirSync(rustDir).sort();

      const { report, exitCode } = await run();

      expect(report.spaces[0]!.status).toBe("matching");
      expect(exitCode).toBe(0);
      expect(files.map(hashFile)).toEqual(before);
      expect(files.map((path) => readFileSync(`${path}-wal`))).toEqual(walBefore);
      expect(readdirSync(tsDir).sort()).toEqual(tsListing);
      expect(readdirSync(rustDir).sort()).toEqual(rustListing);
    } finally {
      ts.close();
      rust.close();
      events.close();
    }
  }, 30_000);
});

describe("arguments", () => {
  test("parses required flags, repeatable --space, and rejects bad input", () => {
    const parsed = parseShadowDigestArgs([
      "--ts-dir",
      "/data/spaces",
      "--rust-dir=/shadow/spaces",
      "--events",
      "/data/roomy-events.sqlite",
      "--space",
      "did:plc:a",
      "--space",
      "did:plc:b.sqlite",
      "--out",
      "/shadow/digest.json",
      "--json",
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.options.tsDir).toBe("/data/spaces");
    expect(parsed.value.options.rustDir).toBe("/shadow/spaces");
    expect(parsed.value.options.eventsPath).toBe("/data/roomy-events.sqlite");
    expect(parsed.value.options.spaces).toEqual(["did:plc:a", "did:plc:b.sqlite"]);
    expect(parsed.value.out).toBe("/shadow/digest.json");
    expect(parsed.value.json).toBe(true);

    expect(parseShadowDigestArgs(["--ts-dir", "/only-ts"]).ok).toBe(false);
    expect(parseShadowDigestArgs(["--nope"]).ok).toBe(false);
    expect(
      parseShadowDigestArgs([
        "--ts-dir",
        "/a",
        "--rust-dir",
        "/b",
        "--events",
        "/c",
        "--space",
      ]).ok,
    ).toBe(false);
  });
});

describe("--space narrows the run", () => {
  test("only the selected space is reported", async () => {
    const tip = await writeEvents(eventsPath);
    await buildSpace(spacePath(tsDir));
    await buildSpace(spacePath(rustDir));
    setWorkerCursor(spacePath(rustDir), tip);
    // A second space production serves and the shadow does not.
    const other = "did:plc:other-space";
    await buildSpace(join(tsDir, `${other}.sqlite`));

    const all = await run();
    expect(all.report.spaces.map((s) => s.space)).toEqual([other, STREAM]);
    expect(all.report.spaces[0]!.status).toBe("missing-rust");

    const { report, exitCode } = await runShadowDigest({
      tsDir,
      rustDir,
      eventsPath,
      spaces: [STREAM],
    });

    expect(report.spaces.map((s) => s.space)).toEqual([STREAM]);
    expect(report.spaces[0]!.status).toBe("matching");
    expect(exitCode).toBe(0);
  }, 30_000);
});
