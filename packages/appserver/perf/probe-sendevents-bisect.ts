#!/usr/bin/env bun
/**
 * Bisect the `sendEvents` post-insert section.
 *
 * On production `space.roomy.space.sendEvents` runs 10-180x slower than the
 * same code against a local probe. Existing telemetry brackets the request
 * with four log lines and localises the time to between `[materialize] done`
 * and the handler's own `sendEvents done` — the post-insert section, after
 * `applyBatch` returns. That section is several awaits wide and the log lines
 * only bound it, so this probe splits it per step and reports where the time
 * lands.
 *
 * It drives the production `StreamManager` → `Router` objects that
 * `createAppserver` builds, so a section slow here is slow there.
 *
 * Modes (mutually exclusive; default `--solo`):
 *
 *   --solo            one request at a time. The local-probe shape, and the
 *                     control: if the section is fast solo, no per-request
 *                     code path explains production.
 *   --concurrent <n>  n overlapping `sendEvents` for the SAME space. The
 *                     post-insert section serializes per stream
 *                     (`#runSerialized`), so a queue wait lands on the outer
 *                     total while the inner sections stay flat.
 *   --cross <n>       n overlapping requests over DIFFERENT spaces. Nothing
 *                     serializes across streams, so any section that slows
 *                     here is contending for a shared resource: the global
 *                     DB, the read-state DB, or a process-wide loop.
 *
 *   --background      leave the embed sweeper / search indexer / push
 *                     dispatcher running. They are off by default because they
 *                     are pokes off the write path; turning them on is the
 *                     only way to see a background loop that shares a worker
 *                     with it.
 *   --http            drive the XRPC handler instead of `StreamManager`
 *                     directly, when the handler itself is in question.
 *
 * Usage:
 *   bun run packages/appserver/perf/probe-sendevents-bisect.ts --solo
 *   bun run packages/appserver/perf/probe-sendevents-bisect.ts --concurrent 8
 *   bun run packages/appserver/perf/probe-sendevents-bisect.ts --cross 8
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid, StreamDid } from "@roomy-space/sdk";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb, openGlobalDb, openReadStateDb, openSpaceDb } from "../src/db/db.ts";
import { getStreamManager, StreamManager } from "../src/streams/StreamManager.ts";
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

const CONCURRENT = numArg("concurrent", 0);
const CROSS = numArg("cross", 0);
const ITERATIONS = numArg("iterations", 40);
const WARMUP = numArg("warmup", 5);
const USE_HTTP = argv.includes("--http");
const BACKGROUND = argv.includes("--background");
const KEEP = argv.includes("--keep");
/**
 * Production-shaped `read_positions`. Both write-path read-state lookups
 * filter by `room_id` alone, so their cost scales with the table's TOTAL
 * size (readership across every space) rather than with the room being
 * written to. An empty table makes both look free, which is how a
 * read-state-shaped cost stays invisible to a probe.
 */
const READ_STATE_ROOMS = numArg("read-state-rooms", 0);
const READ_STATE_READERS = numArg("read-state-readers", 200);

const USER = "did:plc:bisect-user";

// ─── Stage timing ─────────────────────────────────────────────────────────

/**
 * Section timings. Every section the log lines leave unmeasured is an
 * awaitable call on the production objects, so each is timed by wrapping the
 * callable and summing into its bucket — the numbers are the production code
 * path, not a reimplementation of it.
 */
const STAGE_NAMES = {
  total: "00 sendEvents (caller observes)",
  onEventsApplied: "10 router.onEventsApplied (step 6a)",
} as const;

type StageName = (typeof STAGE_NAMES)[keyof typeof STAGE_NAMES];

const stages: Record<string, number[]> = Object.fromEntries(
  Object.values(STAGE_NAMES).map((n) => [n, [] as number[]]),
);

/**
 * Wrap one prototype method so its duration lands in `stage`'s bucket. The
 * receiver is forwarded with `apply`, since the wrapped methods read private
 * fields off `this` — a `this`-less wrapper throws on the private-field
 * brand check rather than measuring anything.
 */
function timeMethod<T extends object>(proto: T, key: keyof T, stage: StageName): void {
  const original = proto[key] as unknown as (...a: unknown[]) => Promise<unknown>;
  const wrapped = async function (this: unknown, ...args: unknown[]) {
    const start = performance.now();
    try {
      return await original.apply(this, args);
    } finally {
      if (measuring) stages[stage]!.push(performance.now() - start);
    }
  };
  proto[key] = wrapped as unknown as T[keyof T];
}

let measuring = false;

// Only the boundaries the log lines and spans do NOT already cover are worth
// a bucket: the four existing log lines bound the request at entry,
// pre-write, post-materialize and done, so the open question is what sits
// inside the post-insert section between them.
timeMethod(StreamManager.prototype, "sendEvents", STAGE_NAMES.total);
timeMethod(Router.prototype, "onEventsApplied", STAGE_NAMES.onEventsApplied);

// ─── Boot ─────────────────────────────────────────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "probe-bisect-"));
process.env.DATA_DIR = dataDir;

_setAdminDids(["did:plc:bisect-admin"]);
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
  disableBackgroundWorkers: !BACKGROUND,
  happyView: null,
  getProfiles: async () => [],
});

// ─── Fixture ──────────────────────────────────────────────────────────────

const globalDb = openGlobalDb();
const streamManager = getStreamManager();

/** Register a space the way the appserver's write path expects to find it. */
async function seedSpace(space: string, user: string): Promise<string> {
  const db = openSpaceDb(space);
  await globalDb.run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [space, space],
  );
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [space, space]);
  await db.run(
    `insert or ignore into comp_space (entity, handle, allow_public_join, allow_member_invites)
     values (?, ?, ?, ?)`,
    [space, null, 1, 1],
  );
  await db.run("insert or ignore into comp_info (entity, name) values (?, ?)", [space, "Bisect Space"]);
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [user, user]);
  await db.run("insert or ignore into comp_user (did, handle) values (?, ?)", [user, null]);
  await db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", [space, user]);

  const roomEvent = {
    $type: "space.roomy.room.createRoom.v0",
    id: newUlid(),
    kind: "space.roomy.channel",
    name: "bisect-channel",
  };
  await streamManager.sendEvents(StreamDid.assert(space), [roomEvent as never], user);
  return roomEvent.id;
}

function messageEvent(roomId: string): Record<string, unknown> {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    room: roomId,
    body: {
      mimeType: "text/markdown",
      data: { $bytes: Buffer.from("bisect probe").toString("base64") },
    },
    extensions: {},
  };
}

const MAIN_SPACE = StreamDid.assert("did:plc:bisect-main-space");
const MAIN_ROOM = await seedSpace(MAIN_SPACE, USER);

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
      params.push(
        `did:plc:reader-${r}-${u}`,
        `filler-room-${r}`,
        MAIN_SPACE,
        "0".repeat(26),
        u % 3 === 0 ? 4 : 0,
      );
      if (tuples.length >= 400) await flush();
    }
  }
  // Readers on the probe room itself: the createMessage unread bump updates
  // every one of them, so this is the row count the write path actually
  // touches rather than merely scans past.
  for (let u = 0; u < READ_STATE_READERS; u++) {
    tuples.push("(?, ?, ?, ?, ?, 0)");
    params.push(`did:plc:probe-reader-${u}`, MAIN_ROOM, MAIN_SPACE, "0".repeat(26), 0);
    if (tuples.length >= 400) await flush();
  }
  await flush();
  console.log(
    `seeded read_positions: ${(READ_STATE_ROOMS * READ_STATE_READERS).toLocaleString()} filler rows ` +
      `+ ${READ_STATE_READERS} on the probe room in ${(performance.now() - started).toFixed(0)}ms`,
  );
}

/** One space per concurrent slot, so `--cross` never shares a stream queue. */
const crossSpaces: Array<{ space: StreamDid; room: string; user: string }> = [];
for (let i = 0; i < Math.max(CROSS, CONCURRENT); i++) {
  const space = StreamDid.assert(`did:plc:bisect-cross-${i}`);
  const user = `did:plc:bisect-cross-user-${i}`;
  crossSpaces.push({ space, room: await seedSpace(space, user), user });
}

// ─── Measurement ──────────────────────────────────────────────────────────

async function oneRequest(space: StreamDid, user: string, room: string): Promise<void> {
  if (!USE_HTTP) {
    await streamManager.sendEvents(space, [messageEvent(room) as never], user);
    return;
  }
  const res = await fetch(`http://localhost:${handle.port}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: { "X-Test-Did": user, "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: space, events: [messageEvent(room)] }),
  });
  if (!res.ok) throw new Error(`sendEvents ${res.status}: ${await res.text()}`);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** Fire `n` overlapping requests, one per space (or all on the main space). */
async function burst(n: number, sameSpace: boolean): Promise<void> {
  await Promise.all(
    Array.from({ length: n }, (_, i) => {
      if (sameSpace) return oneRequest(MAIN_SPACE, USER, MAIN_ROOM);
      const c = crossSpaces[i % crossSpaces.length]!;
      return oneRequest(c.space, c.user, c.room);
    }),
  );
}

const shape = CONCURRENT > 0
  ? `same space, ${CONCURRENT} concurrent`
  : CROSS > 0
    ? `cross space, ${CROSS} concurrent`
    : "solo";

console.log(
  `\nsendEvents post-insert bisect — ${USE_HTTP ? "http" : "direct"}, ${shape}, ` +
    `iterations=${ITERATIONS}, background=${BACKGROUND ? "on" : "off"}`,
);

// Warmup: JIT, schema init, worker handles. Discarded.
for (let i = 0; i < WARMUP; i++) {
  if (CONCURRENT > 0) await burst(CONCURRENT, true);
  else if (CROSS > 0) await burst(CROSS, false);
  else await oneRequest(MAIN_SPACE, USER, MAIN_ROOM);
}

measuring = true;
for (let i = 0; i < ITERATIONS; i++) {
  if (CONCURRENT > 0) await burst(CONCURRENT, true);
  else if (CROSS > 0) await burst(CROSS, false);
  else await oneRequest(MAIN_SPACE, USER, MAIN_ROOM);
}
measuring = false;

// The sections the log lines leave open are the ones between the boundaries
// the probe can reach. `sendEvents (caller observes)` minus the sections that
// ARE reachable is the part no log line or span currently covers — which is
// the number that decides whether the missing half is per-request work or a
// wait on something shared. Reported per call, so the concurrent modes divide
// out the requests-per-burst.
const perBurst = CONCURRENT || CROSS || 1;
console.log(
  `\n${"section".padEnd(46)} ${"n".padStart(6)} ${"p50".padStart(10)} ${"p90".padStart(10)} ${"max".padStart(10)}`,
);
for (const [label, values] of Object.entries(stages).sort()) {
  if (values.length === 0) continue;
  console.log(
    `${label.padEnd(46)} ${String(values.length).padStart(6)} ` +
      `${percentile(values, 0.5).toFixed(2).padStart(10)} ` +
      `${percentile(values, 0.9).toFixed(2).padStart(10)} ` +
      `${Math.max(...values).toFixed(2).padStart(10)}`,
  );
}
console.log(`\n(one "caller observes" sample per sendEvents call; ${perBurst} call(s) per burst)`);

await handle.close();
closeDb();
if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
console.log("\nBISECT_DONE");
