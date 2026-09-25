#!/usr/bin/env bun
/**
 * Projection A/B probe.
 *
 * Measures the two things a denormalised read projection is supposed to move:
 *
 *   1. READ COST — latency percentiles and DB worker round-trips (split by
 *      destination DB) for the endpoints that carry the invalidation fanout:
 *      room.getMessages, room.getMetadata, room.getThreads,
 *      space.getThreads, space.getActivityFeed, space.getMetadata.
 *
 *   2. FANOUT — for one live `sendEvents` message, how many WebSocket frames
 *      each subscribed client receives and how many follow-up HTTP reads those
 *      frames trigger (the client-side refetch storm that is the actual load).
 *      The probe opens K real sync connections, subscribes the room+space
 *      topics, sends one message, and then issues the follow-up reads the
 *      frames imply, measuring their cost.
 *
 * Both numbers are reported per run and are meant to be diffed between a
 * build with projections and one without.
 *
 * Usage:
 *   APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true \
 *     bun run packages/appserver/perf/probe-projections.ts [options]
 *
 * Options:
 *   --rooms <n>        channels in the space (default 20)
 *   --messages <n>     messages in the hot room (default 3000)
 *   --filler <n>       messages in each of the other rooms (default 20)
 *   --members <n>      read_positions rows on the hot room (default 200)
 *   --clients <n>      sync WS connections for the fanout measurement (default 5)
 *   --iterations <n>   measured requests per endpoint (default 50)
 *   --label <s>        tag printed in the summary JSON
 *   --keep             keep the temp data dir
 *
 * The probe is sensitive to machine load — run it alone, not beside a test
 * suite (same caveat as probe-sendevents.ts).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid, sync } from "@roomy-space/sdk";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import {
  closeDb,
  openDb,
  openSpaceDb,
  openGlobalDb,
  openReadStateDb,
} from "../src/db/db.ts";
import { WorkerLink } from "../src/db/asyncDatabase.ts";
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
const ROOMS = numArg("rooms", 20);
const THREADS = numArg("threads", 12);
const MESSAGES = numArg("messages", 3000);
const FILLER = numArg("filler", 20);
const MEMBERS = numArg("members", 200);
const CLIENTS = numArg("clients", 5);
const ITERATIONS = numArg("iterations", 50);
const WARMUP = numArg("warmup", 10);
const LABEL = argv.includes("--label") ? String(argv[argv.indexOf("--label") + 1]) : "run";
const KEEP = argv.includes("--keep");

const USER = "did:plc:probe-projections-user";
const SPACE = "did:plc:probe-projections-space";

// ─── Instrumentation: DB round-trips by destination ───────────────────────

const rttByDest = new Map<string, number>();
/** Round-trips attributable to one measured request (set by `hit`). */
let recording = false;
let rttThisRequest = 0;
let rttThisRequestByDest = new Map<string, number>();

const origSend = WorkerLink.prototype.send;
WorkerLink.prototype.send = function (
  req: Parameters<WorkerLink["send"]>[0],
  route?: Parameters<WorkerLink["send"]>[1],
) {
  const dest = route?.targetDb ?? "events";
  if (recording) {
    rttThisRequest++;
    rttThisRequestByDest.set(dest, (rttThisRequestByDest.get(dest) ?? 0) + 1);
    rttByDest.set(dest, (rttByDest.get(dest) ?? 0) + 1);
  }
  return origSend.call(this, req, route) as Promise<unknown>;
};

// ─── Boot ─────────────────────────────────────────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "probe-projections-"));
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
  disableBackgroundWorkers: true,
  happyView: null,
  getProfiles: async () => [],
  // The response cache would mask the handler cost this probe is measuring.
  // Projections are a *different* mechanism (durable, per-space, survives
  // restart) and must be measurable on their own.
  disableQueryCache: true,
});
const baseUrl = `http://localhost:${handle.port}`;

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]!;
};

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
await spaceDb.run("insert or ignore into comp_info (entity, name) values (?, ?)", [SPACE, "Projection Probe Space"]);
await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, USER]);
await spaceDb.run("insert or ignore into comp_user (did, handle) values (?, ?)", [USER, null]);
await spaceDb.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", [SPACE, USER]);

// Rooms, through real events so every derived column is production-shaped.
const roomIds: string[] = [];
for (let r = 0; r < ROOMS; r++) {
  const ev = {
    $type: "space.roomy.room.createRoom.v0",
    id: newUlid(),
    kind: "space.roomy.channel",
    name: `probe-channel-${r}`,
  };
  await post([ev]);
  roomIds.push(ev.id);
}
const HOT = roomIds[0]!;

// Threads hanging off the hot channel, each with a link edge to its parent.
// `listThreadActivity` (behind room.getThreads / space.getThreads /
// room.getMetadata's recentThreads) is only exercised when the space has
// thread-shaped rooms — with channels alone it does almost nothing.
const threadIds: string[] = [];
for (let t = 0; t < THREADS; t++) {
  const ev = {
    $type: "space.roomy.room.createRoom.v0",
    id: newUlid(),
    kind: "space.roomy.thread",
    name: `probe-thread-${t}`,
  };
  const link = {
    $type: "space.roomy.link.createRoomLink.v0",
    id: newUlid(),
    room: HOT,
    linkToRoom: ev.id,
    isCreationLink: true,
  };
  await post([ev, link]);
  threadIds.push(ev.id);
}

// Messages. Batched at the appserver's MAX_BATCH_SIZE so the write path runs
// exactly as production runs it.
const seedStart = performance.now();
const sendAll = async (roomId: string, total: number) => {
  for (let sent = 0; sent < total; sent += 50) {
    await post(messageEvents(roomId, Math.min(50, total - sent)));
  }
};
await sendAll(HOT, MESSAGES);
for (let r = 1; r < roomIds.length; r++) await sendAll(roomIds[r]!, FILLER);

// Production-shaped readership: read_positions rows on the hot room mean the
// unread fanout has real recipients to fan out to.
const readStateDb = openReadStateDb();
{
  const tuples: string[] = [];
  const params: unknown[] = [];
  for (let u = 0; u < MEMBERS; u++) {
    tuples.push("(?, ?, ?, ?, ?, 0)");
    params.push(`did:plc:probe-reader-${u}`, HOT, SPACE, "0".repeat(26), 0);
  }
  await readStateDb.run(
    `insert or replace into read_positions
       (user_did, room_id, space_did, seen_up_to, unread_count, updated_at)
     values ${tuples.join(",")}`,
    ...params,
  );
}

// Durable join intent for the caller. `getSpaces` and the unfiltered
// `getActivityFeed` both resolve the caller's space set from this table, then
// fan out per space — with no row, both short-circuit to empty.
await readStateDb.run(
  `insert or replace into user_space_membership
     (user_did, space_did, state, source, source_event_id, updated_at)
   values (?, ?, 'joined', 'probe', ?, ?)`,
  USER,
  SPACE,
  newUlid(),
  Date.now(),
);

console.log(
  `seeded ${ROOMS} rooms (${MESSAGES} msgs in the hot room, ${FILLER} in each of ${ROOMS - 1} others) + ${MEMBERS} readers in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`,
);

// ─── Read-cost measurement ────────────────────────────────────────────────

const ENDPOINTS: Array<{ name: string; path: string }> = [
  { name: "room.getMessages", path: `/xrpc/space.roomy.room.getMessages?roomId=${encodeURIComponent(HOT)}&limit=50` },
  { name: "room.getMetadata", path: `/xrpc/space.roomy.room.getMetadata?roomId=${encodeURIComponent(HOT)}` },
  { name: "room.getThreads", path: `/xrpc/space.roomy.room.getThreads?roomId=${encodeURIComponent(HOT)}` },
  { name: "space.getThreads", path: `/xrpc/space.roomy.space.getThreads?spaceId=${encodeURIComponent(SPACE)}` },
  { name: "space.getActivityFeed", path: `/xrpc/space.roomy.space.getActivityFeed?limit=50` },
  { name: "space.getMetadata", path: `/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(SPACE)}` },
];

interface EndpointSummary {
  p50: number; p95: number; p99: number; max: number;
  rtt: number; byDest: Record<string, number>; status: number;
}

async function hit(path: string): Promise<{ ms: number; status: number }> {
  rttThisRequest = 0;
  rttThisRequestByDest = new Map();
  recording = true;
  const start = performance.now();
  const res = await fetch(`${baseUrl}${path}`, { headers: { "X-Test-Did": USER } });
  await res.arrayBuffer();
  const ms = performance.now() - start;
  recording = false;
  return { ms, status: res.status };
}

console.log(`\n=== ${LABEL} — read cost ===`);
console.log(
  `  ${"endpoint".padEnd(22)}${"p50".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}${"max".padStart(9)}${"db-rtt".padStart(8)}  per-destination`,
);
const readSummary: Record<string, EndpointSummary> = {};
for (const ep of ENDPOINTS) {
  for (let i = 0; i < WARMUP; i++) await hit(ep.path);
  const ms: number[] = [];
  const rtts: number[] = [];
  const destTotals = new Map<string, number>();
  let status = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const r = await hit(ep.path);
    ms.push(r.ms);
    rtts.push(rttThisRequest);
    status = r.status;
    for (const [d, n] of rttThisRequestByDest) destTotals.set(d, (destTotals.get(d) ?? 0) + n);
  }
  const byDest: Record<string, number> = {};
  for (const [d, n] of [...destTotals.entries()].sort((a, b) => b[1] - a[1])) {
    byDest[d] = Number((n / ITERATIONS).toFixed(1));
  }
  readSummary[ep.name] = {
    p50: Number(pct(ms, 50).toFixed(2)),
    p95: Number(pct(ms, 95).toFixed(2)),
    p99: Number(pct(ms, 99).toFixed(2)),
    max: Number(pct(ms, 100).toFixed(2)),
    rtt: Number(pct(rtts, 50).toFixed(1)),
    byDest,
    status,
  };
  const s = readSummary[ep.name]!;
  const dests = Object.entries(byDest).map(([d, n]) => `${d}:${n}`).join(" ");
  console.log(
    `  ${ep.name.padEnd(22)}${s.p50.toFixed(2).padStart(8)}${s.p95.toFixed(2).padStart(8)}${s.p99.toFixed(2).padStart(8)}${s.max.toFixed(2).padStart(9)}${String(s.rtt).padStart(8)}  ${dests}  [${status}]`,
  );
}

// ─── Fanout measurement ───────────────────────────────────────────────────

interface DecodedFrame {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

async function openSyncWs(): Promise<WebSocket> {
  const ticketRes = await fetch(`${baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`, {
    method: "POST",
    headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!ticketRes.ok) throw new Error(`ticket ${ticketRes.status}`);
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  const ws = new WebSocket(
    `ws://localhost:${handle.port}/xrpc/space.roomy.sync.subscribe?ticket=${ticket}`,
  );
  ws.binaryType = "arraybuffer";
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("WS open failed"));
  await promise;
  return ws;
}

function subscribe(ws: WebSocket, topic: "room" | "space" | "stream", id: string): void {
  ws.send(JSON.stringify({ type: "sub", id, topic, cursor: -1 }));
}

const clients: WebSocket[] = [];
const framesByClient: DecodedFrame[][] = [];
for (let i = 0; i < CLIENTS; i++) {
  const ws = await openSyncWs();
  const frames: DecodedFrame[] = [];
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") return;
    try {
      frames.push(sync.decodeCborFrame(ev.data as ArrayBuffer) as DecodedFrame);
    } catch { /* ignore */ }
  };
  subscribe(ws, "room", HOT);
  subscribe(ws, "space", SPACE);
  clients.push(ws);
  framesByClient.push(frames);
}
// Let the subscriptions register (they are authorized asynchronously).
const { promise: subsSettled, resolve: subsDone } = Promise.withResolvers<void>();
setTimeout(subsDone, 600);
await subsSettled;

for (const frames of framesByClient) frames.length = 0;

const fanoutStart = performance.now();
await post(messageEvents(HOT, 1));
const writeMs = performance.now() - fanoutStart;
const { promise: fanoutSettled, resolve: fanoutDone } = Promise.withResolvers<void>();
setTimeout(fanoutDone, 500);
await fanoutSettled;

const perClient = framesByClient.map((f) => f.length);
const kindCounts = new Map<string, number>();
for (const f of framesByClient[0] ?? []) {
  const kind = String(f.header["t"] ?? "?");
  kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
}
const nsidCounts = new Map<string, number>();
for (const f of framesByClient[0] ?? []) {
  if (f.header["t"] !== "#invalidate") continue;
  const nsid = String((f.body as { nsid?: string }).nsid ?? "?");
  nsidCounts.set(nsid, (nsidCounts.get(nsid) ?? 0) + 1);
}

console.log(`\n=== ${LABEL} — live fanout (1 message, ${CLIENTS} subscribed clients) ===`);
console.log(`  sendEvents latency: ${writeMs.toFixed(1)}ms`);
console.log(`  frames per client: ${perClient.join(", ")}`);
console.log(`  frame kinds (client 0): ${[...kindCounts.entries()].map(([k, n]) => `${k}:${n}`).join(" ") || "(none)"}`);
console.log(`  #invalidate nsids (client 0): ${[...nsidCounts.entries()].map(([k, n]) => `${k}:${n}`).join(" ") || "(none)"}`);

// The follow-up reads the frames force, per client. This is the load the
// fanout adds to the appserver: one HTTP read per distinct query key a frame
// tells the client to refetch.
//
// Derived from the frames just observed rather than from a fixed list — a
// hardcoded list keeps reporting the endpoints a diff replaced, which makes the
// probe unable to see the very change it exists to measure. A `#invalidate`
// names one key; the diff frames (`#messageDiff`, `#roomMetadataDiff`,
// `#roomActivityDiff`) patch their entries directly and cost no read.
const READ_PATHS: Record<string, string> = {
  "space.roomy.room.getMetadata": `/xrpc/space.roomy.room.getMetadata?roomId=${encodeURIComponent(HOT)}`,
  "space.roomy.room.getMessages": `/xrpc/space.roomy.room.getMessages?roomId=${encodeURIComponent(HOT)}&limit=50`,
  "space.roomy.room.getThreads": `/xrpc/space.roomy.room.getThreads?roomId=${encodeURIComponent(HOT)}`,
  "space.roomy.space.getThreads": `/xrpc/space.roomy.space.getThreads?spaceId=${encodeURIComponent(SPACE)}`,
  "space.roomy.space.getActivityFeed": `/xrpc/space.roomy.space.getActivityFeed?limit=50`,
  "space.roomy.space.getMetadata": `/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(SPACE)}`,
  "space.roomy.space.getSpaces": `/xrpc/space.roomy.space.getSpaces`,
  "space.roomy.room.getLinks": `/xrpc/space.roomy.room.getLinks?roomId=${encodeURIComponent(HOT)}`,
  "space.roomy.space.getLinks": `/xrpc/space.roomy.space.getLinks?spaceId=${encodeURIComponent(SPACE)}`,
};

const observedNsids = new Set<string>();
for (const f of framesByClient[0] ?? []) {
  if (f.header["t"] !== "#invalidate") continue;
  observedNsids.add(String((f.body as { nsid?: string }).nsid ?? "?"));
}
const followUps = [...observedNsids]
  .map((nsid) => ({ name: nsid, path: READ_PATHS[nsid] }))
  .filter((c): c is { name: string; path: string } => c.path !== undefined);

let followUpMs = 0;
let followUpRtt = 0;
const followUpDetail: string[] = [];
for (const c of followUps) {
  rttThisRequest = 0;
  recording = true;
  const t0 = performance.now();
  await hit(c.path);
  followUpMs += performance.now() - t0;
  recording = false;
  followUpRtt += rttThisRequest;
  followUpDetail.push(`${c.name} ${rttThisRequest}rtt`);
}
console.log(
  `  refetch storm per client: ${followUps.length} requests, ${(followUpMs / CLIENTS).toFixed(1)}ms summed server-side, ${followUpRtt} DB round-trips (${followUpDetail.join(", ") || "none"})`,
);
console.log(`  => ${CLIENTS} clients x ${followUps.length} reads = ${CLIENTS * followUps.length} HTTP requests per message`);

for (const ws of clients) ws.close();

console.log(
  `\nJSON ${JSON.stringify({ label: LABEL, rooms: ROOMS, messages: MESSAGES, members: MEMBERS, clients: CLIENTS, iterations: ITERATIONS, read: readSummary, fanout: { framesPerClient: perClient, frameKinds: Object.fromEntries(kindCounts), invalidates: Object.fromEntries(nsidCounts), followUpReads: followUps.map((c) => c.name), followUpRtt, writeMs: Number(writeMs.toFixed(1)) } })}`,
);

await handle.close();
closeDb();
if (KEEP) console.log(`\ndata dir kept: ${dataDir}`);
else rmSync(dataDir, { recursive: true, force: true });
