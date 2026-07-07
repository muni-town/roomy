/**
 * Benchmark: materialize a single space from the events DB.
 *
 * Usage:
 *   bun run scripts/bench-materialize.ts [--space <did>] [--events-db <path>]
 *
 * Defaults to the largest space in the events DB.
 * Runs with synchronous bun:sqlite (no worker) to measure pure materialization
 * throughput without IPC overhead.
 *
 * Global `fetch` is replaced with a dummy that returns an empty response so
 * any network calls (e.g. profile fetching) don't distort the benchmark.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@atcute/cbor";
import type { DecodedStreamEvent, Event, StreamDid, StreamIndex, UserDid } from "@roomy-space/sdk";
import { applyBatch } from "../src/materialization/applyBatch.ts";
import { toAsyncDb } from "../src/db/syncAdapter.ts";
import type { DbLike } from "../src/db/types.ts";

// ── Dummy fetch: no network calls during benchmark ────────────────────────

const dummyResponse = new Response("[]", {
  status: 200,
  headers: { "content-type": "application/json" },
});
globalThis.fetch = async () => dummyResponse;

// ── Paths ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const SCHEMA_PATH = join(__dirname, "..", "src", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let spaceDid = "";
let eventsDbPath = join(DATA_DIR, "roomy-events.sqlite");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--space" && i + 1 < args.length) spaceDid = args[++i];
  if (args[i] === "--events-db" && i + 1 < args.length) eventsDbPath = args[++i];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

function formatRate(count: number, elapsedMs: number): string {
  return `${(count / (elapsedMs / 1000)).toFixed(0)} evt/s`;
}

// ── Timed DbLike wrapper ────────────────────────────────────────────────────

interface TimedCall {
  type: string;
  sql: string;
  count: number;
  totalMs: number;
}

const callStats = new Map<string, TimedCall>();

function trackCall(type: string, sql: string, elapsedMs: number): void {
  let key = sql;
  if (type === "exec") {
    if (key.startsWith("savepoint evt_")) key = "savepoint evt_<ulid>";
    else if (key.startsWith("release evt_")) key = "release evt_<ulid>";
    else if (key.startsWith("rollback to evt_")) key = "rollback to evt_<ulid>";
  }
  const mapKey = `${type}:${key}`;
  let entry = callStats.get(mapKey);
  if (!entry) {
    entry = { type, sql: key, count: 0, totalMs: 0 };
    callStats.set(mapKey, entry);
  }
  entry.count++;
  entry.totalMs += elapsedMs;
}

function wrapDb(db: DbLike): DbLike {
  return {
    query(sql: string) {
      const stmt = db.query(sql);
      const origGet = stmt.get.bind(stmt);
      const origAll = stmt.all.bind(stmt);
      return {
        get<T>(...params: unknown[]): Promise<T | null> {
          const t0 = Bun.nanoseconds();
          return origGet(...params).then((r) => {
            trackCall("query.get", sql, (Bun.nanoseconds() - t0) / 1_000_000);
            return r;
          });
        },
        all<T>(...params: unknown[]): Promise<T[]> {
          const t0 = Bun.nanoseconds();
          return origAll(...params).then((r) => {
            trackCall("query.all", sql, (Bun.nanoseconds() - t0) / 1_000_000);
            return r;
          });
        },
      };
    },
    async prepare(sql: string) {
      const stmt = await db.prepare(sql);
      const origRun = stmt.run.bind(stmt);
      const origGet = stmt.get.bind(stmt);
      const origAll = stmt.all.bind(stmt);
      return {
        run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
          const t0 = Bun.nanoseconds();
          return origRun(...params).then((r) => {
            trackCall("prepare.run", sql, (Bun.nanoseconds() - t0) / 1_000_000);
            return r;
          });
        },
        get<T>(...params: unknown[]): Promise<T | null> {
          const t0 = Bun.nanoseconds();
          return origGet(...params).then((r) => {
            trackCall("prepare.get", sql, (Bun.nanoseconds() - t0) / 1_000_000);
            return r;
          });
        },
        all<T>(...params: unknown[]): Promise<T[]> {
          const t0 = Bun.nanoseconds();
          return origAll(...params).then((r) => {
            trackCall("prepare.all", sql, (Bun.nanoseconds() - t0) / 1_000_000);
            return r;
          });
        },
      };
    },
    exec(sql: string): Promise<void> {
      const t0 = Bun.nanoseconds();
      return db.exec(sql).then(() => {
        trackCall("exec", sql, (Bun.nanoseconds() - t0) / 1_000_000);
      });
    },
    run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
      const t0 = Bun.nanoseconds();
      return db.run(sql, ...params).then((r) => {
        trackCall("run", sql, (Bun.nanoseconds() - t0) / 1_000_000);
        return r;
      });
    },
    transaction<T>(steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }>): Promise<T> {
      const t0 = Bun.nanoseconds();
      return db.transaction(steps).then((r) => {
        trackCall("transaction", `[${steps.length} steps]`, (Bun.nanoseconds() - t0) / 1_000_000);
        return r;
      });
    },
    close(): Promise<void> {
      return db.close();
    },
  };
}

// ── Event type counter ─────────────────────────────────────────────────────

const eventTypeCounts = new Map<string, number>();

// ── Open events DB ──────────────────────────────────────────────────────────

const eventsDb = new Database(eventsDbPath);
eventsDb.exec("pragma synchronous = normal");

// ── Find target space ──────────────────────────────────────────────────────

if (!spaceDid) {
  const row = eventsDb
    .query("SELECT stream_id, COUNT(*) as cnt FROM stream_events GROUP BY stream_id ORDER BY cnt DESC LIMIT 1")
    .get() as { stream_id: string; cnt: number } | null;
  if (!row) throw new Error("No events found in events DB");
  spaceDid = row.stream_id;
  console.log(`Auto-selected largest space: ${spaceDid} (${row.cnt} events)`);
} else {
  const row = eventsDb
    .query("SELECT COUNT(*) as cnt FROM stream_events WHERE stream_id = ?")
    .get(spaceDid) as { cnt: number } | null;
  console.log(`Space: ${spaceDid} (${row?.cnt ?? 0} events)`);
}

// ── Read events ─────────────────────────────────────────────────────────────

const t0 = Bun.nanoseconds();
const rawEvents = eventsDb
  .query("SELECT idx, user, payload FROM stream_events WHERE stream_id = ? ORDER BY idx")
  .all(spaceDid) as Array<{ idx: number; user: string; payload: Uint8Array }>;
const t1 = Bun.nanoseconds();
const readTime = (t1 - t0) / 1_000_000;
console.log(`  Read ${rawEvents.length} events from DB: ${formatMs(readTime)}`);

// ── Decode events + count types ────────────────────────────────────────────

const t2 = Bun.nanoseconds();
const decodedEvents: DecodedStreamEvent[] = rawEvents.map(
  (e): DecodedStreamEvent => {
    const event = decode(e.payload) as Event;
    const type = event.$type as string;
    eventTypeCounts.set(type, (eventTypeCounts.get(type) ?? 0) + 1);
    return {
      idx: e.idx as StreamIndex,
      event,
      user: e.user as UserDid,
    };
  },
);
const t3 = Bun.nanoseconds();
const decodeTime = (t3 - t2) / 1_000_000;
console.log(`  Decoded ${decodedEvents.length} events (CBOR): ${formatMs(decodeTime)}`);

// ── Print event type breakdown ──────────────────────────────────────────────

const sortedTypes = [...eventTypeCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`  Event types:`);
for (const [type, count] of sortedTypes) {
  const short = type.replace(/^space\.roomy\./, "");
  console.log(`    ${short}: ${count}`);
}

// ── Create fresh materialization DB ────────────────────────────────────────

const t4 = Bun.nanoseconds();
const db = new Database(":memory:");
db.exec("pragma journal_mode = wal");
db.exec("pragma synchronous = normal");
db.exec("pragma foreign_keys = on");
const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
db.exec(schemaSql);
db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
const asyncDb: DbLike = wrapDb(toAsyncDb(db));
const t5 = Bun.nanoseconds();
console.log(`  Created materialization DB: ${formatMs((t5 - t4) / 1_000_000)}`);

// ── Seed space entity ──────────────────────────────────────────────────────

const t6 = Bun.nanoseconds();
const stats = await applyBatch(asyncDb, spaceDid as StreamDid, decodedEvents, {
  isBackfill: true,
});
const t7 = Bun.nanoseconds();
const elapsed = (t7 - t6) / 1_000_000;

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\n── Results ──────────────────────────────────────`);
console.log(`  Applied:          ${stats.applied}`);
console.log(`  Materializer err: ${stats.materializerErrors}`);
console.log(`  Apply errors:     ${stats.applyErrors}`);
console.log(`  Total time:       ${formatMs(elapsed)}`);
console.log(`  Throughput:       ${formatRate(decodedEvents.length, elapsed)}`);
console.log(`  Per-event:        ${(elapsed / decodedEvents.length).toFixed(3)}ms`);

// ── Time breakdown ──────────────────────────────────────────────────────────

const sortedCalls = [...callStats.values()].sort((a, b) => b.totalMs - a.totalMs);
let totalDbMs = 0;
for (const entry of sortedCalls) {
  totalDbMs += entry.totalMs;
}
const nonDbMs = elapsed - totalDbMs;

console.log(`\n── Time breakdown ─────────────────────────────`);
console.log(`  DB time:          ${formatMs(totalDbMs).padStart(8)}  (${(totalDbMs / elapsed * 100).toFixed(0)}%)`);
console.log(`  Non-DB time:      ${formatMs(nonDbMs).padStart(8)}  (${(nonDbMs / elapsed * 100).toFixed(0)}%)`);
console.log(`    (materializer JS, async scheduling, logging, etc.)`);

// ── DB call breakdown ───────────────────────────────────────────────────────

console.log(`\n── DB call breakdown ────────────────────────────`);
for (const entry of sortedCalls) {
  const avg = entry.totalMs / entry.count;
  const sqlShort = entry.sql.length > 60 ? entry.sql.slice(0, 60) + "..." : entry.sql;
  console.log(`  ${entry.type.padEnd(12)} x${String(entry.count).padStart(6)}  ${formatMs(entry.totalMs).padStart(8)} total  ${avg.toFixed(3)}ms avg  ${sqlShort}`);
}
console.log(`  ${"".padEnd(12)} ${"".padStart(6)}  ${formatMs(totalDbMs).padStart(8)} total DB time`);

// ── Verify DB state ────────────────────────────────────────────────────────

const entityCount = db.query("SELECT COUNT(*) as c FROM entities").get() as { c: number };
const edgeCount = db.query("SELECT COUNT(*) as c FROM edges").get() as { c: number };
const contentCount = db.query("SELECT COUNT(*) as c FROM comp_content").get() as { c: number };
console.log(`\n  DB state: ${entityCount.c} entities, ${edgeCount.c} edges, ${contentCount.c} content rows`);

// Cleanup
db.close();
eventsDb.close();
