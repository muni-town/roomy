#!/usr/bin/env bun
/**
 * At-scale verification of the dashboard fix through the REAL handler.
 *
 * Boots the appserver against an event log seeded to production shape, then
 * calls `space.roomy.admin.getDashboardStats` over HTTP and times it. Run with
 * the fix and with it reverted to get the before/after.
 *
 * Usage:
 *   APPSERVER_TEST_MODE=true bun run packages/appserver/perf/probe-dashboard.ts --rows=3000000
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb, openEventsDb } from "../src/db/db.ts";
import { _setAdminDids } from "../src/admin.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../src/embed/sweeper.ts";
import { _resetSearchIndexer, stopSearchIndexer } from "../src/search/indexer.ts";
import { _setTestGetProfiles } from "../src/queries/profileStore.ts";

const argv = process.argv;
const numArg = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const ROWS = numArg("rows", 3_000_000);
const STREAMS = 4382;
const ADMIN = "did:plc:probe-admin";
const LABEL = argv.includes("--label") ? (argv[argv.indexOf("--label") + 1] ?? "run") : "run";

const dataDir = mkdtempSync(join(tmpdir(), "probe-dashboard-"));
process.env.DATA_DIR = dataDir;
const eventsPath = join(dataDir, "roomy-events.sqlite");

// Seed the event log on a raw connection before the pool opens it.
{
  const db = new Database(eventsPath, { create: true });
  db.exec("pragma journal_mode = wal");
  db.exec(`create table if not exists stream_events (
      stream_id text not null, idx integer not null, user text not null,
      payload blob not null, signature blob not null default x'',
      event_type text, created_at integer, primary key (stream_id, idx)) strict;`);
  db.exec(`create table if not exists stream_state (
      stream_id text primary key, latest_event integer not null default 0) strict;`);

  const dids = Array.from({ length: STREAMS }, (_, i) =>
    `did:plc:${i.toString(36).padStart(24, "0")}`);
  const payload = new Uint8Array(256).fill(7);
  const now = Date.now();
  const hourRows = 500;
  const dayRows = 12_000;

  db.exec("begin");
  const ins = db.prepare("insert into stream_events values (?, ?, ?, ?, x'', ?, ?)");
  const counts = new Map<string, number>();
  for (let i = 0; i < ROWS; i++) {
    const sid = dids[i % STREAMS]!;
    const idx = counts.get(sid) ?? 0; counts.set(sid, idx + 1);
    const createdAt =
      i < hourRows ? now - (i % 3600) * 1000
        : i < dayRows ? now - 3600_000 - ((i - hourRows) % (23 * 3600)) * 1000
          : now - 86400_000 - ((i - dayRows) % (30 * 86400)) * 1000;
    ins.run(sid, idx, "did:plc:benchuser00000000000000", payload,
      "space.roomy.message.createMessage.v0", createdAt);
  }
  db.exec("commit");
  db.exec("begin");
  const st = db.prepare("insert into stream_state (stream_id, latest_event) values (?, ?)");
  for (const r of db.query("select stream_id, max(idx) mx from stream_events group by stream_id").all() as Array<{ stream_id: string; mx: number }>) {
    st.run(r.stream_id, r.mx);
  }
  db.exec("commit");
  db.close();
  console.log(`seeded ${ROWS} rows / ${STREAMS} streams`);
}

_setAdminDids([ADMIN]);
await stopEmbedSweeper();
await stopSearchIndexer();
closeDb();
_resetEmbedSweeper();
_resetSearchIndexer();

openDb({ path: eventsPath });
_setTestGetProfiles(async () => []);
const handle = await createAppserver({
  authVerifier: testAuthVerifier,
  port: 0,
  dbPath: eventsPath,
  readStateDbPath: join(dataDir, "roomy-readstate.sqlite"),
  quiet: true,
  disableBackgroundWorkers: true,
  happyView: null,
});

// Sanity: the rollup must agree with the log.
{
  const events = openEventsDb();
  const sum = await events.query("select coalesce(sum(latest_event + 1), 0) as n from stream_state").get<{ n: number }>();
  const cnt = await events.query("select count(*) as n from stream_events").get<{ n: number }>();
  console.log(`  rollup totalEvents=${sum?.n}  log rows=${cnt?.n}  ${sum?.n === cnt?.n ? "MATCH" : "MISMATCH"}`);
}

const ms: number[] = [];
let body: Record<string, any> = {};
for (let i = 0; i < 7; i++) {
  const t = performance.now();
  const res = await fetch(`http://localhost:${handle.port}/xrpc/space.roomy.admin.getDashboardStats`, {
    headers: { "X-Test-Did": ADMIN },
  });
  ms.push(performance.now() - t);
  if (i === 0) {
    body = (await res.json()) as Record<string, any>;
    if (res.status !== 200) console.log(`  HTTP ${res.status}: ${JSON.stringify(body)}`);
  } else {
    await res.arrayBuffer();
  }
}
ms.sort((a, b) => a - b);
console.log(`\n=== ${LABEL} (rows=${ROWS}) ===`);
console.log(`  getDashboardStats  min ${ms[0]!.toFixed(0)}ms  p50 ${ms[3]!.toFixed(0)}ms  max ${ms[6]!.toFixed(0)}ms`);
console.log(`  activity: ${JSON.stringify(body.activity ?? {})}`);

await handle.close();
closeDb();
rmSync(dataDir, { recursive: true, force: true });
