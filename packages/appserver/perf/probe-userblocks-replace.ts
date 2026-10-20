#!/usr/bin/env bun
/**
 * Before/after probe for `replaceBlockRows` (`queries/userBlocks.ts`), the write
 * that stores a user's resolved block set, through the real pool and its worker
 * thread rather than a raw `bun:sqlite` handle.
 *
 * The write was one `delete` plus one single-row `insert` per block, all inside
 * one `db.transaction`. The transaction is one replacement and must stay one
 * transaction — but a block set is an account's whole repo, and a repo is not
 * bounded. Measured against production `db-slow` spans, that shape costs ~65µs
 * per record: 0.56ms at 101 records against 3.7s at 56.5k, and the accounts
 * carrying those sets hold 10k–16.5k blocks. The replacement carries the set as
 * one binding instead, which is what this measures.
 *
 * Sections, all on one fixture:
 *
 *   steps       the step-array write: N step objects, N statements in the worker.
 *   set-based   `delete` + one `insert ... select from json_each(?)` + the stamp.
 *   payload     what the single binding costs to serialize and to carry.
 *   contention  a two-step write on the same worker, quiet and behind big writes.
 *   unchanged   what it would cost to detect that a fetched set equals the
 *               stored one and skip the rewrite.
 *
 * Usage:
 *   bun run perf/probe-userblocks-replace.ts [--blocks 50000] [--others 600]
 *     [--runs 7] [--only steps|payload|contention|unchanged]
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, openDb, openReadStateDb } from "../src/db/db.ts";
import { replaceBlockRows } from "../src/queries/userBlocks.ts";

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};

const BLOCKS = arg("blocks", 50_000);
const OTHERS = arg("others", 600);
const OTHERS_BLOCKS = arg("othersBlocks", 100);
const RUNS = arg("runs", 7);
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "";

const USER = "did:plc:bulkuser";
const EMPTY = "did:plc:nobody";
const NOW = Date.now();

const __dirname = dirname(fileURLToPath(import.meta.url));
const READSTATE_SCHEMA = readFileSync(
  join(__dirname, "..", "src", "db", "readStateSchema.sql"),
  "utf8",
);

const dataDir = mkdtempSync(join(tmpdir(), "probe-userblocks-"));
process.env.DATA_DIR = dataDir;
const readStatePath = join(dataDir, "roomy-readstate.sqlite");

// Seed the read-state DB on a raw connection before the pool opens it: one
// account with BLOCKS rows, plus OTHERS with a realistic handful each, so the
// table is the size the delete's index walk actually sees.
{
  const db = new Database(readStatePath, { create: true });
  db.exec("pragma journal_mode = wal");
  db.exec(READSTATE_SCHEMA);
  const insert = db.prepare(
    `insert into user_blocks (user_did, blocked_did, source, created_at, fetched_at)
     values (?, ?, ?, ?, ?)`,
  );
  const seed = db.transaction(() => {
    for (let i = 0; i < BLOCKS; i++) {
      insert.run(USER, `did:plc:blocked${i}`, i % 2 ? "roomy" : "bluesky", NOW, NOW);
    }
    for (let u = 0; u < OTHERS; u++) {
      for (let i = 0; i < OTHERS_BLOCKS; i++) {
        insert.run(`did:plc:other${u}`, `did:plc:member${i}`, "roomy", NOW, NOW);
      }
    }
  });
  seed();
  db.close();
}

openDb({ path: join(dataDir, "roomy-events.sqlite") });
// The pool opens the DBs lazily; this also waits for init to complete.
const handle = openReadStateDb();
await handle.query("select 1 as one").get();

const total = Number(
  (await handle.query("select count(*) as n from user_blocks").get<{ n: number }>())?.n,
);

/** The records a fetch of USER returns, in the shape `replaceBlockRows` binds. */
const records = Array.from({ length: BLOCKS }, (_, i) => ({
  subject: `did:plc:blocked${i}`,
  source: (i % 2 ? "roomy" : "bluesky") as "roomy" | "bluesky",
  createdAt: NOW,
}));

const INSERT_ROW = `insert into user_blocks (user_did, blocked_did, source, created_at, fetched_at)
     values (?, ?, ?, ?, ?)`;
const INSERT_SET = `insert into user_blocks (user_did, blocked_did, source, created_at, fetched_at)
  select ?, value ->> 0, value ->> 1, value ->> 2, ? from json_each(?)`;
const DELETE = "delete from user_blocks where user_did = ?";
const STAMP = `insert into user_block_fetches (user_did, fetched_at, status) values (?, ?, 'ok')
     on conflict(user_did) do update set fetched_at = excluded.fetched_at, status = excluded.status`;

/** The replaced shape: one `delete` plus one single-row `insert` per record. */
async function stepWrite(): Promise<void> {
  const steps: Array<{ type: "run"; sql: string; params: unknown[] }> = [
    { type: "run", sql: DELETE, params: [USER] },
  ];
  for (const record of records) {
    steps.push({
      type: "run",
      sql: INSERT_ROW,
      params: [USER, record.subject, record.source, record.createdAt, NOW],
    });
  }
  steps.push({ type: "run", sql: STAMP, params: [USER, NOW] });
  await handle.transaction(steps);
}

/** Restore the pre-state: USER's rows present, nothing else touched. */
async function restore(): Promise<void> {
  await handle.transaction([
    { type: "run", sql: DELETE, params: [USER] },
    {
      type: "run",
      sql: INSERT_SET,
      params: [USER, NOW, JSON.stringify(records.map((r) => [r.subject, r.source, r.createdAt]))],
    },
  ]);
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const line = (label: string, xs: number[], unit = "ms") => {
  const s = xs.slice().sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(42)} p50 ${median(s).toFixed(2)}${unit}  max ${s[s.length - 1]!.toFixed(2)}${unit}`,
  );
};

console.log(
  `\n=== replaceBlockRows through the readstate worker: ${BLOCKS} records for one account, ${OTHERS * OTHERS_BLOCKS} for ${OTHERS} others (${total} rows) ===`,
);

if (!ONLY || ONLY === "steps") {
  // Interleaved rather than one shape after the other: the worker is shared with
  // whatever else the process is doing, and a run of one shape after a run of the
  // other would let that drift land on one side only.
  const stepMs: number[] = [];
  const setMs: number[] = [];
  await restore();
  await stepWrite();
  await replaceBlockRows(handle, USER, records);
  for (let i = 0; i < RUNS; i++) {
    await restore();
    let t = performance.now();
    await stepWrite();
    stepMs.push(performance.now() - t);

    await restore();
    t = performance.now();
    await replaceBlockRows(handle, USER, records);
    setMs.push(performance.now() - t);
  }
  const before = median(stepMs);
  const after = median(setMs);
  console.log(
    `  steps      (one statement per record)   p50 ${before.toFixed(1)}ms  [${stepMs.map((n) => n.toFixed(0)).join(" ")}]`,
  );
  console.log(
    `  set-based  (one statement for the set)  p50 ${after.toFixed(1)}ms  [${setMs.map((n) => n.toFixed(0)).join(" ")}]`,
  );
  console.log(
    `  ${(before / after).toFixed(1)}x  —  ${((before / BLOCKS) * 1000).toFixed(1)}µs/record against ${((after / BLOCKS) * 1000).toFixed(1)}µs/record`,
  );
  console.log(
    `  the set survived both shapes: ${(await handle.query("select count(*) as n from user_blocks where user_did = ?").get<{ n: number }>(USER))?.n} rows`,
  );
}

if (!ONLY || ONLY === "payload") {
  const t0 = performance.now();
  const payload = JSON.stringify(records.map((r) => [r.subject, r.source, r.createdAt]));
  const stringifyMs = performance.now() - t0;
  const carry: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await handle.transaction([{ type: "run", sql: "select length(?)", params: [payload] }]);
    carry.push(performance.now() - t);
  }
  const insert: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await handle.run(DELETE, USER);
    const t = performance.now();
    await handle.run(INSERT_SET, USER, NOW, payload);
    insert.push(performance.now() - t);
  }
  console.log(
    `\n  payload: ${(payload.length / 1e6).toFixed(2)}MB, JSON.stringify ${stringifyMs.toFixed(1)}ms`,
  );
  line("carried over the worker boundary, not run", carry);
  line(`parsed and inserted by the statement`, insert);
}

if (!ONLY || ONLY === "contention") {
  // A two-step transaction — a delete matching nothing plus the stamp — is the
  // cheapest write the appserver issues, yet production logs it against the same
  // 50ms floor as a 56k-record replace. A worker serialises its requests, so this
  // separates "the statements are slow" from "the statements were waiting".
  const emptyWrite = () =>
    handle.transaction([
      { type: "run", sql: DELETE, params: [EMPTY] },
      { type: "run", sql: STAMP, params: [EMPTY, Date.now()] },
    ]);
  const sample = async (n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await emptyWrite();
      out.push(performance.now() - t);
    }
    return out;
  };
  console.log("\n  a two-step write (delete matching nothing + stamp), quiet and busy:");
  line("quiet, nothing else in flight", await sample(50));
  const inFlight = [
    restore(),
    restore(),
    restore(),
  ];
  line("issued behind 3 concurrent replaces", await sample(20));
  await Promise.all(inFlight);
  line("quiet again", await sample(50));
}

if (!ONLY || ONLY === "unchanged") {
  // `warmBlockSet` refetches an account's own set once per cache window, and an
  // unchanged set still goes through delete-and-insert. What skipping it costs:
  // `except` is a set difference over both sides — a dropped subject is as much a
  // change as an added one — and needs the stored set projected the same way the
  // payload is.
  const DIFF = `select count(*) as n from (
      select blocked_did, source, created_at from user_blocks where user_did = ?1
      except
      select value ->> 0, value ->> 1, value ->> 2 from json_each(?2)
    ) union all select count(*) from (
      select value ->> 0, value ->> 1, value ->> 2 from json_each(?2)
      except
      select blocked_did, source, created_at from user_blocks where user_did = ?1
    )`;
  const payload = JSON.stringify(records.map((r) => [r.subject, r.source, r.createdAt]));
  const compare: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const diff = await handle.query(DIFF).all<{ n: number }>(USER, payload);
    compare.push(performance.now() - t);
    if (diff.length !== 2 || diff[0]!.n !== 0 || diff[1]!.n !== 0) {
      throw new Error(`comparison says changed: ${JSON.stringify(diff)}`);
    }
  }
  const rewrite: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await replaceBlockRows(handle, USER, records);
    rewrite.push(performance.now() - t);
  }
  console.log("\n  detecting an unchanged set:");
  line("set-difference comparison (except, both ways)", compare);
  line("the rewrite it would avoid", rewrite);
}

closeDb();
rmSync(dataDir, { recursive: true, force: true });
