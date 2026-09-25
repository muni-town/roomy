#!/usr/bin/env bun
/**
 * Write-path profiler for `space.roomy.space.sendEvents`.
 *
 * Boots the real appserver (worker pool, real per-space DBs on disk) against a
 * seeded space and reports, per sendEvents call:
 *
 *   - end-to-end latency percentiles and throughput
 *   - DB worker round-trips, split by destination DB
 *   - time inside each stage of StreamManager.sendEvents
 *   - every outbound (non-local) network fetch the write path made
 *
 * The network line is the important one: the write path is supposed to be
 * local-only, so any non-local fetch listed here is a defect, not a slow step.
 *
 * Usage:
 *   APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true \
 *     bun run packages/appserver/perf/probe-sendevents.ts [options]
 *
 * Options:
 *   --mode <create|delete>  event kind measured (default create)
 *   --batch <n>        events per call (default 1)
 *   --iterations <n>   calls measured (default 20)
 *   --warmup <n>       calls discarded (default 3)
 *   --concurrency <n>  parallel in-flight calls (default 1)
 *   --seed-profile     pre-populate the author's profile row
 *   --read-state-rooms <n>    filler rooms seeded in read_positions (default 0)
 *   --read-state-readers <n>  readers per filler room (default 50)
 *   --keep             keep the temp data dir
 *
 * `--read-state-rooms` is not optional in spirit: `read_positions` is global
 * and its write-path lookups are room-scoped, so with an empty table (the
 * default) their plans are trivially fast and a missing index is invisible.
 * See docs/sendevents-write-path-review.md.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@roomy-space/sdk";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb, openSpaceDb, openGlobalDb, openReadStateDb } from "../src/db/db.ts";
import { WorkerLink } from "../src/db/asyncDatabase.ts";
import { StreamManager } from "../src/streams/StreamManager.ts";
import { Router } from "../src/invalidation/router.ts";
import { _setAdminDids } from "../src/admin.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../src/embed/sweeper.ts";
import { _resetSearchIndexer, stopSearchIndexer } from "../src/search/indexer.ts";
import { _resetProfileStoreCache } from "../src/queries/profileStore.ts";

// ─── Args ─────────────────────────────────────────────────────────────────

const argv = process.argv;
const numArg = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const BATCH = numArg("batch", 1);
const ITERATIONS = numArg("iterations", 20);
const WARMUP = numArg("warmup", 3);
const CONCURRENCY = numArg("concurrency", 1);
const SEED_PROFILE = argv.includes("--seed-profile");
// Production-shaped read_positions. The default (0) leaves the table empty,
// which hides a whole class of write-path cost: both `read_positions` queries
// `sendEvents` issues — the createMessage unread bump and the delete/move
// unwind — filter by `room_id`, a column the primary key cannot serve. With
// an empty table every plan is trivially fast; with a realistic one an
// unindexed scan is O(rows) and was invisible to this probe. See
// docs/sendevents-write-path-review.md.
const READ_STATE_ROOMS = numArg("read-state-rooms", 0);
const READ_STATE_READERS = numArg("read-state-readers", 50);
// `--mode delete` exercises the delete side-effects instead of
// createMessage. Those run one read-state unwind per distinct room in the
// batch, so they are the sharpest amplifier of an unindexed `room_id` scan.
const strArg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1]) : fallback;
};
const MODE = strArg("mode", "create");
const KEEP = argv.includes("--keep");

const USER = "did:plc:probe-user";
const SPACE = "did:plc:probe-space";

// ─── Instrumentation ──────────────────────────────────────────────────────

/** Round-trips by destination DB, and wall time by worker request type. */
const rttByDest = new Map<string, number>();
const msByType = new Map<string, number>();
const countByType = new Map<string, number>();
let recording = false;

const origSend = WorkerLink.prototype.send;
WorkerLink.prototype.send = function (
  req: Parameters<WorkerLink["send"]>[0],
  route?: Parameters<WorkerLink["send"]>[1],
) {
  const dest = route?.targetDb ?? "events";
  const promise = origSend.call(this, req, route) as Promise<unknown>;
  if (!recording) return promise;
  const start = performance.now();
  rttByDest.set(dest, (rttByDest.get(dest) ?? 0) + 1);
  countByType.set(req.type, (countByType.get(req.type) ?? 0) + 1);
  const done = () => msByType.set(req.type, (msByType.get(req.type) ?? 0) + (performance.now() - start));
  promise.then(done, done);
  return promise;
};

/** Stacked stage timings inside StreamManager.sendEvents. */
type Stage = "insert" | "profiles" | "applyBatch" | "invalidation" | "total";
const stageMs: Record<Stage, number> = {
  insert: 0, profiles: 0, applyBatch: 0, invalidation: 0, total: 0,
};
const stageCalls: Record<Stage, number> = {
  insert: 0, profiles: 0, applyBatch: 0, invalidation: 0, total: 0,
};

/**
 * Wrap one prototype method with a timer. Uses the runtime receiver (`this`),
 * not the prototype object, so class private fields resolve.
 */
const timeStage = <T extends object>(proto: T, key: keyof T, stage: Stage) => {
  const orig = proto[key] as unknown as (...a: unknown[]) => Promise<unknown>;
  const wrapped = async function (this: unknown, ...a: unknown[]) {
    const start = performance.now();
    try {
      return await orig.apply(this, a);
    } finally {
      if (recording) {
        stageMs[stage] += performance.now() - start;
        stageCalls[stage]++;
      }
    }
  };
  proto[key] = wrapped as unknown as T[keyof T];
};

const origStreamSend = StreamManager.prototype.sendEvents;
StreamManager.prototype.sendEvents = async function (
  this: StreamManager,
  ...args: Parameters<StreamManager["sendEvents"]>
) {
  const start = performance.now();
  try {
    return await origStreamSend.apply(this, args);
  } finally {
    if (recording) {
      stageMs.total += performance.now() - start;
      stageCalls.total++;
    }
  }
};
timeStage(Router.prototype, "onEventsApplied", "invalidation");

/** Outbound (non-local) fetches: a local-only path must report zero. */
interface OutboundFetch { url: string; ms: number; stack: string; }
const outbound: OutboundFetch[] = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const isLocal = url.startsWith("http://localhost") || url.startsWith("http://127.");
  const start = performance.now();
  try {
    return await origFetch(input as never, init as never);
  } finally {
    if (recording && !isLocal) {
      outbound.push({
        url,
        ms: performance.now() - start,
        stack: new Error().stack?.split("\n").slice(2, 14).join("\n    ") ?? "",
      });
    }
  }
};

// ─── Boot ─────────────────────────────────────────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "probe-sendevents-"));
process.env.DATA_DIR = dataDir;

_setAdminDids(["did:plc:probe-admin"]);
await stopEmbedSweeper();
await stopSearchIndexer();
closeDb();
_resetEmbedSweeper();
_resetSearchIndexer();
_resetProfileStoreCache();

openDb({ path: join(dataDir, "roomy-events.sqlite") });

const handle = await createAppserver({
  authVerifier: testAuthVerifier,
  port: 0,
  dbPath: join(dataDir, "roomy-events.sqlite"),
  readStateDbPath: join(dataDir, "roomy-readstate.sqlite"),
  quiet: true,
  // Background loops (embed sweeper, search indexer, push dispatcher) are
  // pokes off the write path, not latency: leave them off so the numbers are
  // the synchronous write path alone.
  disableBackgroundWorkers: true,
  happyView: null,
  // Production leaves `getProfiles` unset, so materialization uses the real
  // HappyView-first / Bluesky path (and writes the rows it resolves). The
  // stub keeps the probe hermetic; --production-profiles exercises the real
  // pipeline so fetch counts match production.
  ...(argv.includes("--production-profiles") ? {} : { getProfiles: async () => [] }),
});
const baseUrl = `http://localhost:${handle.port}`;

// ─── Fixture ──────────────────────────────────────────────────────────────

async function post(events: Record<string, unknown>[]): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: SPACE, events }),
  });
  if (!res.ok) throw new Error(`sendEvents ${res.status}: ${await res.text()}`);
  return performance.now() - start;
}

function messageEvents(roomId: string, n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    room: roomId,
    body: {
      mimeType: "text/markdown",
      data: { $bytes: Buffer.from(`probe message ${i}`).toString("base64") },
    },
    extensions: {},
  }));
}

const globalDb = openGlobalDb();
const spaceDb = openSpaceDb(SPACE);

await globalDb.run(
  "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
  [SPACE, SPACE],
);
await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
await spaceDb.run(
  `insert or ignore into comp_space (entity, handle, allow_public_join, allow_member_invites)
   values (?, ?, ?, ?)`,
  [SPACE, null, 1, 1],
);
await spaceDb.run("insert or ignore into comp_info (entity, name) values (?, ?)", [SPACE, "Probe Space"]);
await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, USER]);
await spaceDb.run("insert or ignore into comp_user (did, handle) values (?, ?)", [USER, null]);
await spaceDb.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", [SPACE, USER]);
if (SEED_PROFILE) {
  await globalDb.run(
    "insert or replace into profiles (did, handle, name) values (?, ?, ?)",
    [USER, "probe.test", "Probe User"],
  );
}

// The room is created through a real event so every materialised column is
// populated exactly as production populates it.
const roomEvent = {
  $type: "space.roomy.room.createRoom.v0",
  id: newUlid(),
  kind: "space.roomy.channel",
  name: "probe-channel",
};
await post([roomEvent]);
const ROOM = roomEvent.id;

// Production-shaped read-state. Both write-path read_positions queries filter
// by `room_id`, a column no index serves, so their cost scales with the
// table's TOTAL size (readership across every space) rather than with the
// room being written to. An empty table makes both look free — which is how
// the missing index stayed invisible. Seed filler rooms plus a realistic
// reader set on the probe room itself.
if (READ_STATE_ROOMS > 0) {
  const readStateDb = openReadStateDb();
  const started = performance.now();
  let tuples: string[] = [];
  let params: unknown[] = [];
  const flush = async () => {
    if (tuples.length === 0) return;
    await readStateDb.run(
      `insert or replace into read_positions
         (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
       values ${tuples.join(",")}`,
      ...params,
    );
    tuples = [];
    params = [];
  };
  for (let r = 0; r < READ_STATE_ROOMS; r++) {
    for (let u = 0; u < READ_STATE_READERS; u++) {
      tuples.push("(?, ?, ?, ?, ?, 0)");
      // A third unread, so the delete/move unwind's `unread_count > 0`
      // filter has work to do.
      params.push(`did:plc:reader-${r}-${u}`, `filler-room-${r}`, SPACE, "0".repeat(26), u % 3 === 0 ? 4 : 0);
      if (tuples.length >= 400) await flush();
    }
  }
  // Readers on the probe room: the createMessage bump updates every one.
  for (let u = 0; u < READ_STATE_READERS; u++) {
    tuples.push("(?, ?, ?, ?, ?, 0)");
    params.push(`did:plc:probe-reader-${u}`, ROOM, SPACE, "0".repeat(26), 0);
    if (tuples.length >= 400) await flush();
  }
  await flush();
  console.log(
    `seeded read_positions: ${(READ_STATE_ROOMS * READ_STATE_READERS).toLocaleString()} filler rows + ${READ_STATE_READERS} on the probe room in ${(performance.now() - started).toFixed(0)}ms`,
  );
}

// Delete mode needs materialised messages to remove. Seed them through the
// real write path so every derived column is populated exactly as production
// populates it, and spread them over distinct rooms when the delete batch is
// larger than one: the unwind runs per distinct room, which is the shape that
// multiplied the unindexed scan.
const deleteTargets: Array<{ room: string; messageId: string }> = [];
if (MODE === "delete") {
  const roomIds: string[] = [ROOM];
  for (let r = 1; r < BATCH; r++) {
    const ev = {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
      name: `probe-channel-${r}`,
    };
    await post([ev]);
    roomIds.push(ev.id);
  }
  const need = (ITERATIONS + WARMUP) * BATCH + 1;
  for (let i = 0; i < need; i++) {
    const room = roomIds[i % roomIds.length]!;
    const ev = {
      $type: "space.roomy.message.createMessage.v0",
      id: newUlid(),
      room,
      body: {
        mimeType: "text/markdown",
        data: { $bytes: Buffer.from(`probe seed ${i}`).toString("base64") },
      },
      extensions: {},
    };
    await post([ev]);
    deleteTargets.push({ room, messageId: ev.id });
  }
  console.log(`seeded ${deleteTargets.length} messages across ${roomIds.length} rooms for delete mode`);
}

let deleteCursor = 0;
/** One measured batch, shaped by `--mode`. */
const nextBatch = (): Record<string, unknown>[] => {
  if (MODE !== "delete") return messageEvents(ROOM, BATCH);
  return Array.from({ length: BATCH }, () => {
    const t = deleteTargets[deleteCursor++]!;
    return {
      $type: "space.roomy.message.deleteMessage.v0",
      id: newUlid(),
      room: t.room,
      messageId: t.messageId,
    };
  });
};

// ─── Measure ──────────────────────────────────────────────────────────────

// A pinger measures the blast radius: a stall local to one request must not
// show up here, a process-wide one will.
const pingLatencies: number[] = [];
let pingStop = false;
const ping = async () => {
  while (!pingStop) {
    const start = performance.now();
    try {
      await fetch(`${baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(SPACE)}`, {
        headers: { "X-Test-Did": USER },
      });
    } catch { /* teardown */ }
    pingLatencies.push(performance.now() - start);
    await new Promise((r) => setTimeout(r, 20));
  }
};

for (let i = 0; i < WARMUP; i++) await post(nextBatch());
recording = true;
const pinging = ping();
const latencies: number[] = [];
const wallStart = performance.now();
for (let off = 0; off < ITERATIONS; off += CONCURRENCY) {
  const n = Math.min(CONCURRENCY, ITERATIONS - off);
  const batch = await Promise.all(Array.from({ length: n }, () => post(nextBatch())));
  latencies.push(...batch);
}
const wall = performance.now() - wallStart;
recording = false;
pingStop = true;
await pinging;

// ─── Report ───────────────────────────────────────────────────────────────

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]!;
};

console.log(`\nsendEvents write-path profile — mode=${MODE} batch=${BATCH} concurrency=${CONCURRENCY} n=${latencies.length}`);
console.log(`  p50 ${pct(latencies, 50).toFixed(1)}ms   p95 ${pct(latencies, 95).toFixed(1)}ms   p99 ${pct(latencies, 99).toFixed(1)}ms`);
console.log(`  throughput ${((latencies.length / wall) * 1000).toFixed(1)} req/s (${((latencies.length * BATCH) / wall * 1000).toFixed(0)} evt/s)`);
console.log(`  concurrent getMetadata pinger: p50 ${pct(pingLatencies, 50).toFixed(1)}ms  p95 ${pct(pingLatencies, 95).toFixed(1)}ms  max ${pct(pingLatencies, 100).toFixed(1)}ms`);

const n = latencies.length;
const rttTotal = [...rttByDest.values()].reduce((a, b) => a + b, 0);
console.log(`\nDB round-trips: ${rttTotal} total, ${(rttTotal / n).toFixed(1)} per call, ${(rttTotal / n / BATCH).toFixed(1)} per event`);
for (const [dest, count] of [...rttByDest.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${dest.padEnd(10)} ${String(count).padStart(6)}  (${(count / n).toFixed(1)}/call)`);
}

console.log(`\nstage time per call (mean):`);
for (const stage of ["insert", "profiles", "applyBatch", "invalidation"] as Stage[]) {
  if (stageCalls[stage] === 0) continue;
  console.log(`    ${stage.padEnd(14)} ${(stageMs[stage] / stageCalls[stage]).toFixed(2)}ms  (${stageCalls[stage]} calls)`);
}
console.log(`    ${"TOTAL write".padEnd(14)} ${(stageMs.total / stageCalls.total).toFixed(2)}ms`);
console.log(`    ${"handler pre-write".padEnd(14)} ${(pct(latencies, 50) - stageMs.total / stageCalls.total).toFixed(2)}ms (approx, p50 minus write)`);

console.log(`\nworker time by request type:`);
for (const [type, count] of [...countByType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${type.padEnd(20)} ${String(count).padStart(5)}  ${(msByType.get(type) ?? 0).toFixed(0)}ms total  ${((msByType.get(type) ?? 0) / count).toFixed(2)}ms mean`);
}

console.log(`\noutbound (non-local) fetches: ${outbound.length}`);
if (outbound.length > 0) {
  console.log(`  ^ the write path is supposed to be local-only; each line below is a defect`);
  for (const f of outbound.slice(0, 3)) {
    console.log(`    ${f.ms.toFixed(0)}ms  ${f.url.slice(0, 110)}`);
    console.log(`    ${f.stack}`);
  }
}

await handle.close();
closeDb();
if (KEEP) console.log(`\ndata dir kept: ${dataDir}`);
else rmSync(dataDir, { recursive: true, force: true });
