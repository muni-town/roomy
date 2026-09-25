#!/usr/bin/env bun
/**
 * Per-stage probe for `space.roomy.space.getThreads` against a REAL dataset.
 *
 * `probe-projections.ts` measures synthetic fixtures it seeds itself. This probe
 * measures an already-materialised data directory under
 * `packages/appserver/data`, so the numbers describe a realistic multi-space
 * shape: a large space, hundreds of rooms, a channel with tens of thousands of
 * messages, and whatever projection state that DB is actually in.
 *
 * Two instruments, both reusing machinery that already exists:
 *
 *  1. `WorkerLink.prototype.send` interception (same technique as
 *     `probe-projections.ts`), extended from "round-trips by destination worker"
 *     to "round-trips by SQL shape". Every statement is classified into the
 *     stage that issued it and both the count and the wall time spent inside
 *     the worker are attributed to that stage, so the per-stage table is a
 *     direct measurement of the request rather than an estimate.
 *
 *  2. The handler's own spans. A global tracer provider backed by an
 *     `InMemorySpanExporter` is installed before `createAppserver`, which is
 *     what lets this read `roomy.thread_count` / `roomy.visible_room_count` and
 *     the `getThreads.listActivity` / `getThreads.roomAccess` durations without
 *     a collector.
 *
 * Usage:
 *   bun run perf/probe-getthreads.ts --space did:plc:... --did did:plc:... \
 *     [--limit 50] [--iterations 10] [--warmup 3] [--label before] \
 *     [--stub-profiles] [--cold]
 *
 * `--cold` re-opens nothing; it simply reports the FIRST measured request
 * separately, which is the request that pays any read-path warm.
 */

import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../src/db/db.ts";
import { WorkerLink } from "../src/db/asyncDatabase.ts";
import type { DbRoute } from "../src/db/types.ts";
import { _setAdminDids } from "../src/admin.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../src/embed/sweeper.ts";
import { _resetSearchIndexer, stopSearchIndexer } from "../src/search/indexer.ts";
import {
  _resetProfileStoreCache,
  _setTestGetProfiles,
} from "../src/queries/profileStore.ts";

// ─── Args ─────────────────────────────────────────────────────────────────

const argv = process.argv;
const strArg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1]) : fallback;
};
const numArg = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};

const SPACE = strArg("space", "");
const DID = strArg("did", "");
const LIMIT = numArg("limit", 50);
const ITERATIONS = numArg("iterations", 10);
const WARMUP = numArg("warmup", 2);
const LABEL = strArg("label", "run");
const STUB_PROFILES = argv.includes("--stub-profiles");
const COLD = argv.includes("--cold");
/** Clear this space's projection rows before measuring — the state a
 *  blue-green rebuild leaves behind (schema present, rows invalidated). */
const CLEAR_PROJECTION = argv.includes("--clear-projection");
/** Walk the whole board with cursors, reporting the cost of each page. */
const PAGES = numArg("pages", 0);
/** Repeat the walk; report the per-page MINIMUM, which is the stall-free cost
 *  on a noisy CI box (see the ambient-floor section in the report). */
const REPEATS = numArg("repeats", 1);

if (!SPACE || !DID) {
  console.error("usage: probe-getthreads.ts --space <did> --did <caller-did>");
  process.exit(2);
}

// ─── Instrument 1: round-trips classified by the stage that issued them ───

/**
 * Stage classifier. Order matters: the first match wins, so the narrower
 * shapes must precede the broader ones they are substrings of.
 */
const STAGES: Array<{ name: string; match: RegExp }> = [
  // --- the page query itself (listThreadActivity) ---
  { name: "a.page_query", match: /join comp_room cr on cr\.entity = e\.id[\s\S]*order by sort_key desc/ },

  // --- room_activity projection: read, warm, or the scan fallback ---
  { name: "b.projection_read", match: /select room_id, latest_message_id, latest_at, recent_authors/ },
  { name: "b.projection_warm", match: /insert into room_activity/ },
  { name: "b.scan.latest_ts", match: /max\(coalesce\(cc\.timestamp, fwd_cc\.timestamp\)\) as ts/ },
  { name: "b.scan.participants", match: /group by msg\.room, coalesce\(author_e\.tail, fwd_author_e\.tail\)/ },
  { name: "b.scan.latest_winner", match: /coalesce\(cc\.timestamp, fwd_cc\.timestamp\) as timestamp/ },
  { name: "b.scan.latest_content", match: /author_info\.name as author_name/ },
  { name: "b.scan.room_shape", match: /select cr\.entity as room_id, cr\.label as label, ci\.name as name[\s\S]*where cr\.entity in/ },
  { name: "b.scan.parent_edges", match: /select tail, head from edges[\s\S]*canonical_parent/ },
  { name: "b.projected.board_shape", match: /coalesce\(a\.tail, fa\.tail\) as author_did/ },
  { name: "b.projected.member_info", match: /select entity, name, avatar from comp_info/ },

  // --- room_access ---
  { name: "c.room_access.projection_read", match: /select room_id, space_id, parent_channel_id/ },
  { name: "c.room_access.projection_warm", match: /insert into room_access/ },
  { name: "c.room_access.fallback_rooms", match: /select e\.id as id, e\.stream_id as space_id from entities e where e\.id in/ },
  { name: "c.room_access.default_access", match: /select entity, default_access from comp_room where entity in/ },
  { name: "c.room_access.role_grants", match: /from role_rooms/ },
  { name: "c.room_access.parent_links", match: /select tail, head from edges[\s\S]*label = 'link'/ },

  // --- channel names ---
  { name: "d.channel_names", match: /select e\.id as id, ci\.name as name/ },

  // --- read state ---
  { name: "e.read_positions.ensure", match: /insert into read_positions/ },
  { name: "e.read_positions.select", match: /from read_positions/ },
  { name: "e.engaged_threads", match: /from user_thread_activity/ },

  // --- space-level access gates ---
  { name: "f.space.member", match: /label = 'member' limit 1/ },
  { name: "f.space.admin", match: /label = 'admin' limit 1/ },
  { name: "f.space.banned", match: /from comp_bans/ },
  { name: "f.space.public_join", match: /coalesce\(allow_public_join, 1\)/ },

  // --- profiles ---
  { name: "g.profiles.read", match: /from profiles where did in/ },
];

function classify(sql: string | undefined): string {
  if (!sql) return "other";
  for (const s of STAGES) if (s.match.test(sql)) return s.name;
  return "other";
}

interface StageStat {
  rtt: number;
  ms: number;
  errors: number;
  /** Rows returned into JS — what the fold above has to walk. */
  rows: number;
  /** Approximate structured-clone payload, dominated by `comp_content.data`. */
  bytes: number;
}

/**
 * Approximate the payload a worker response carries back into this thread:
 * the cost that is charged per row returned and is therefore independent of
 * how contended the machine is. Buffers count by their length, which is how a
 * message body lands.
 */
function payloadSize(value: unknown, seen = new WeakSet<object>()): { rows: number; bytes: number } {
  if (value == null) return { rows: 0, bytes: 4 };
  if (typeof value === "string") return { rows: 0, bytes: value.length };
  if (typeof value === "number" || typeof value === "boolean") return { rows: 0, bytes: 8 };
  if (value instanceof Uint8Array) return { rows: 0, bytes: value.length };
  if (Array.isArray(value)) {
    let rows = value.length;
    let bytes = 0;
    for (const v of value) {
      const s = payloadSize(v, seen);
      rows += s.rows;
      bytes += s.bytes;
    }
    return { rows, bytes };
  }
  if (typeof value === "object") {
    const obj = value as object;
    if (seen.has(obj)) return { rows: 0, bytes: 0 };
    seen.add(obj);
    let bytes = 0;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      bytes += k.length + payloadSize(v, seen).bytes;
    }
    return { rows: 0, bytes };
  }
  return { rows: 0, bytes: 0 };
}

let recording = false;
const perRequest = new Map<string, StageStat>();
let totalRtt = 0;
let destCounts = new Map<string, number>();

function addStat(
  map: Map<string, StageStat>,
  kind: string,
  ms: number,
  failed: boolean,
  payload: { rows: number; bytes: number },
): void {
  let s = map.get(kind);
  if (!s) {
    s = { rtt: 0, ms: 0, errors: 0, rows: 0, bytes: 0 };
    map.set(kind, s);
  }
  s.rtt++;
  s.ms += ms;
  s.rows += payload.rows;
  s.bytes += payload.bytes;
  if (failed) s.errors++;
}

const origSend = WorkerLink.prototype.send;
WorkerLink.prototype.send = function (
  req: Parameters<WorkerLink["send"]>[0],
  route?: Parameters<WorkerLink["send"]>[1],
) {
  const started = performance.now();
  const isRecorded = recording;
  const kind = isRecorded ? classify(req.sql) : "other";
  const dest = (route as DbRoute | undefined)?.targetDb ?? "events";
  const p = origSend.call(this, req, route) as Promise<unknown>;
  if (isRecorded) {
    p.then(
      (result) => {
        addStat(perRequest, kind, performance.now() - started, false, payloadSize(result));
        totalRtt++;
        destCounts.set(dest, (destCounts.get(dest) ?? 0) + 1);
      },
      () => {
        addStat(perRequest, kind, performance.now() - started, true, { rows: 0, bytes: 0 });
        totalRtt++;
        destCounts.set(dest, (destCounts.get(dest) ?? 0) + 1);
      },
    );
  }
  return p;
};

// ─── Instrument 2: the handler's own spans ────────────────────────────────

const spanExporter = new InMemorySpanExporter();
const spanProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
trace.setGlobalTracerProvider(spanProvider);

function spanMs(span: { startTime: [number, number]; endTime: [number, number] }): number {
  const [sSec, sNs] = span.startTime;
  const [eSec, eNs] = span.endTime;
  return (eSec - sSec) * 1000 + (eNs - sNs) / 1e6;
}

// ─── Boot against the real data directory ─────────────────────────────────

process.env.APPSERVER_TEST_MODE = "true";
_setAdminDids([DID]);
_setTestGetProfiles(STUB_PROFILES ? async () => [] : null);

await stopEmbedSweeper();
await stopSearchIndexer();
closeDb();
_resetEmbedSweeper();
_resetSearchIndexer();
_resetProfileStoreCache();

openDb();

const handle = await createAppserver({
  authVerifier: testAuthVerifier,
  port: 0,
  quiet: true,
  disableBackgroundWorkers: true,
  happyView: null,
  getProfiles: async () => [],
  disableQueryCache: true,
});
const baseUrl = `http://localhost:${handle.port}`;
const target = `/xrpc/space.roomy.space.getThreads?spaceId=${encodeURIComponent(SPACE)}&limit=${LIMIT}`;

/**
 * Reproduce the state a blue-green rebuild leaves behind: the projection
 * tables exist (schema applied) but hold no rows for this space, because
 * rematerialisation invalidates rather than populates. Done through the pool's
 * per-space handle so it lands in the same DB the handler reads.
 */
if (CLEAR_PROJECTION) {
  const spaceDb = openSpaceDb(SPACE);
  await spaceDb.run("delete from room_activity");
  await spaceDb.run("delete from room_access");
  const ra = await spaceDb.query("select count(*) as n from room_activity").get<{ n: number }>();
  console.log(`--clear-projection: room_activity rows now ${ra?.n}`);
}

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]!;
};

// ─── Measurement ──────────────────────────────────────────────────────────

interface RequestSample {
  ms: number;
  status: number;
  rtt: number;
  stages: Record<string, StageStat>;
  dest: Record<string, number>;
  spans: Record<string, number>;
  attrs: Record<string, number | string>;
  rooms: number;
}

async function hit(): Promise<RequestSample> {
  perRequest.clear();
  totalRtt = 0;
  destCounts = new Map();
  spanExporter.reset();
  recording = true;
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}${target}`, { headers: { "X-Test-Did": DID } });
  const body = (await res.json()) as { rooms?: unknown[] };
  const ms = performance.now() - t0;
  recording = false;

  const spans: Record<string, number> = {};
  const attrs: Record<string, number | string> = {};
  for (const span of spanExporter.getFinishedSpans()) {
    spans[span.name] = Number(spanMs(span as never).toFixed(2));
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === "number" || typeof v === "string") attrs[k] = v;
    }
  }

  const stages: Record<string, StageStat> = {};
  for (const [k, v] of perRequest) stages[k] = { ...v, ms: Number(v.ms.toFixed(2)) };
  void payloadSize;

  return {
    ms,
    status: res.status,
    rtt: totalRtt,
    stages,
    dest: Object.fromEntries(destCounts),
    spans,
    attrs,
    rooms: Array.isArray(body.rooms) ? body.rooms.length : -1,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────

const samples: RequestSample[] = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) samples.push(await hit());
const measured = samples.slice(WARMUP);
const first = samples[0]!;

const ms = measured.map((s) => s.ms);
const rtts = measured.map((s) => s.rtt);

// Per-stage totals, summed over the measured requests and averaged per request.
const stageTotals = new Map<string, StageStat>();
for (const s of measured) {
  for (const [k, v] of Object.entries(s.stages)) {
    const cur = stageTotals.get(k) ?? { rtt: 0, ms: 0, errors: 0, rows: 0, bytes: 0 };
    cur.rtt += v.rtt;
    cur.ms += v.ms;
    cur.errors += v.errors;
    cur.rows += v.rows;
    cur.bytes += v.bytes;
    stageTotals.set(k, cur);
  }
}

console.log(`\n=== ${LABEL} — ${SPACE} (limit ${LIMIT}, ${ITERATIONS} measured, ${WARMUP} warmup) ===`);
console.log(
  `  wall ms: p50 ${pct(ms, 50).toFixed(1)}  p95 ${pct(ms, 95).toFixed(1)}  max ${pct(ms, 100).toFixed(1)}   first(unwarmed) ${first.ms.toFixed(1)}`,
);
console.log(
  `  status ${first.status}  rooms ${first.rooms}  thread_count ${first.attrs["roomy.thread_count"]}  room_count ${first.attrs["roomy.room_count"]}  visible_room_count ${first.attrs["roomy.visible_room_count"]}`,
);
console.log(`  db round-trips per request: ${pct(rtts, 50)}  by destination: ${JSON.stringify(first.dest)}`);
// `min` is the estimator that matters on a contended box: the smallest time a
// statement was ever observed to take is the closest thing to its stall-free
// cost, where the mean and even the p50 carry whatever the VM was doing at the
// time. Rows/kB are deterministic and stall-independent.
console.log(
  `\n  ${"stage".padEnd(28)}${"rtt".padStart(5)}${"rows".padStart(7)}${"kB".padStart(8)}${"min ms".padStart(8)}${"p50 ms".padStart(8)}${"mean ms".padStart(9)}${"errs".padStart(6)}`,
);
for (const [k, v] of [...stageTotals.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  const vals = measured.map((s) => s.stages[k]?.ms ?? 0);
  console.log(
    `  ${k.padEnd(28)}${(v.rtt / measured.length).toFixed(1).padStart(5)}${(v.rows / measured.length).toFixed(0).padStart(7)}${(v.bytes / measured.length / 1024).toFixed(1).padStart(8)}${Math.min(...vals).toFixed(2).padStart(8)}${pct(vals, 50).toFixed(2).padStart(8)}${(v.ms / measured.length).toFixed(2).padStart(9)}${String(v.errors).padStart(6)}`,
  );
}
const allBytes = [...stageTotals.values()].reduce((a, v) => a + v.bytes, 0) / measured.length;
const allRows = [...stageTotals.values()].reduce((a, v) => a + v.rows, 0) / measured.length;
console.log(`  ${"TOTAL".padEnd(30)}${"".padStart(8)}${allRows.toFixed(0).padStart(9)}${(allBytes / 1024).toFixed(1).padStart(8)}`);
console.log(`\n  latency modes (the distribution is bimodal — reporting only a mean hides it):`);
{
  const sorted = [...measured].sort((a, b) => a.ms - b.ms);
  const mid = 25;
  const fast = sorted.filter((s) => s.ms < mid);
  const slow = sorted.filter((s) => s.ms >= mid);
  for (const [name, group] of [["fast (<25ms)", fast], ["slow (>=25ms)", slow]] as const) {
    if (group.length === 0) continue;
    const gms = group.map((s) => s.ms);
    const worst = [...group].sort((a, b) => b.ms - a.ms)[0]!;
    const top = Object.entries(worst.stages)
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${v.ms.toFixed(0)}ms`)
      .join(" ");
    console.log(
      `  ${name.padEnd(14)} n=${String(group.length).padStart(3)}  p50 ${pct(gms, 50).toFixed(1)}ms  worst ${worst.ms.toFixed(1)}ms`,
    );
    console.log(
      `      worst split: wall ${worst.ms.toFixed(1)} = handler-span ${(worst.spans["space.roomy.space.getThreads"] ?? 0).toFixed(1)} + pre/post-handler ${(worst.ms - (worst.spans["space.roomy.space.getThreads"] ?? 0)).toFixed(1)}; inside handler: db ${Object.values(worst.stages).reduce((a, s) => a + s.ms, 0).toFixed(1)} + js ${((worst.spans["space.roomy.space.getThreads"] ?? 0) - Object.values(worst.stages).reduce((a, s) => a + s.ms, 0)).toFixed(1)}`,
    );
    console.log(`      worst-case stages: ${top}`);
  }
}

const spanNames = [...new Set(measured.flatMap((s) => Object.keys(s.spans)))];
console.log(`\n  handler spans (ms, p50 of the measured requests):`);
for (const name of spanNames) {
  const vals = measured.map((s) => s.spans[name] ?? 0);
  console.log(`  ${name.padEnd(32)}${pct(vals, 50).toFixed(2).padStart(10)}`);
}

const firstStages = Object.fromEntries(
  Object.entries(first.stages).map(([k, v]) => [k, { rtt: v.rtt, ms: Number(v.ms.toFixed(2)), errors: v.errors }]),
);
console.log(
  `\nJSON ${JSON.stringify({
    label: LABEL,
    space: SPACE,
    limit: LIMIT,
    iterations: ITERATIONS,
    wall: { p50: Number(pct(ms, 50).toFixed(2)), p95: Number(pct(ms, 95).toFixed(2)), max: Number(pct(ms, 100).toFixed(2)), first: Number(first.ms.toFixed(2)) },
    rtt: pct(rtts, 50),
    dest: first.dest,
    rooms: first.rooms,
    attrs: first.attrs,
    stagesPerRequest: Object.fromEntries(
      [...stageTotals.entries()].map(([k, v]) => [
        k,
        {
          rtt: Number((v.rtt / measured.length).toFixed(2)),
          ms: Number((v.ms / measured.length).toFixed(2)),
          rows: Number((v.rows / measured.length).toFixed(1)),
          bytes: Number((v.bytes / measured.length).toFixed(0)),
          minMs: Number(Math.min(...measured.map((s) => s.stages[k]?.ms ?? 0)).toFixed(2)),
          errors: v.errors,
        },
      ]),
    ),
    firstRequestStages: firstStages,
    spans: Object.fromEntries(
      spanNames.map((n) => [n, Number(pct(measured.map((s) => s.spans[n] ?? 0), 50).toFixed(2))]),
    ),
  })}`,
);

if (COLD) {
  console.log(`\n  FIRST (unwarmed) request stage detail:`);
  for (const [k, v] of Object.entries(firstStages).sort((a, b) => b[1].ms - a[1].ms)) {
    console.log(`  ${k.padEnd(32)}${String(v.rtt).padStart(9)}${v.ms.toFixed(2).padStart(10)}${String(v.errors).padStart(8)}`);
  }
}

// ─── Whole-board walk (what the index page actually issues) ───────────────

if (PAGES > 0) {
  console.log(`\n  === ${LABEL} — cursor walk, limit ${LIMIT}, ${REPEATS} repeat(s) ===`);
  console.log(`  ${"page".padStart(5)}${"rooms".padStart(7)}${"run1 ms".padStart(10)}${"stage ms".padStart(10)}${"scan rtt".padStart(10)}`);
  let totalMin = 0;
  const best: Array<{ page: number; ms: number; rooms: number }> = [];
  for (let rep = 0; rep < REPEATS; rep++) {
    let cursor: string | null = null;
    for (let page = 1; page <= PAGES; page++) {
      perRequest.clear();
      totalRtt = 0;
      destCounts = new Map();
      spanExporter.reset();
      recording = true;
      const t0 = performance.now();
      const url = `${baseUrl}${target}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await fetch(url, { headers: { "X-Test-Did": DID } });
      const body = (await res.json()) as { rooms?: unknown[]; cursor?: string };
      const ms = performance.now() - t0;
      recording = false;
      const nRooms = Array.isArray(body.rooms) ? body.rooms.length : -1;
      const stageMs = [...perRequest.values()].reduce((a, s) => a + s.ms, 0);
      const scan = [...perRequest.entries()]
        .filter(([k]) => k.startsWith("b.scan") || k === "b.projection_warm")
        .reduce((a, [, s]) => a + s.rtt, 0);

      const slot = best[page - 1] ?? { page, ms: Infinity, rooms: nRooms };
      slot.rooms = nRooms;
      if (ms < slot.ms) slot.ms = ms;
      best[page - 1] = slot;

      if (rep === 0 && PAGES <= 12) {
        const top = [...perRequest.entries()]
          .sort((a, b) => b[1].ms - a[1].ms)
          .slice(0, 4)
          .map(([k, s]) => `${k.replace(/^[a-g]\./, "")}=${s.ms.toFixed(1)}ms`)
          .join(" ");
        console.log(
          `  ${String(page).padStart(5)}${String(nRooms).padStart(7)}${ms.toFixed(1).padStart(10)}${"".padStart(10)}${stageMs.toFixed(1).padStart(10)}${String(scan).padStart(10)}   ${top}`,
        );
      }
      cursor = body.cursor ?? null;
      if (!cursor) break;
    }
  }
  console.log(`  ${"page".padStart(5)}${"rooms".padStart(7)}${"min ms".padStart(10)}`);
  const walk: Array<{ page: number; minMs: number; rooms: number }> = [];
  for (const [i, b] of best.entries()) {
    totalMin += b.ms;
    console.log(`  ${String(b.page).padStart(5)}${String(b.rooms).padStart(7)}${b.ms.toFixed(1).padStart(10)}`);
    walk.push({ page: i + 1, minMs: Number(b.ms.toFixed(1)), rooms: b.rooms });
  }
  console.log(
    `  walk minimum-of-${REPEATS} total: ${totalMin.toFixed(0)}ms over ${walk.length} page(s)  (${(totalMin / walk.length).toFixed(1)}ms/page)`,
  );
  console.log(`WALKJSON ${JSON.stringify({ label: LABEL, repeats: REPEATS, pages: walk, totalMinMs: Number(totalMin.toFixed(1)) })}`);
}

// ─── Ambient latency floor ────────────────────────────────────────────────
//
// The cost of ONE round-trip on the read-state worker, measured with no
// handler work in front of it. On a quiet box this is single-digit ms; on a
// contended one (a 2-vCPU CI runner, a loaded dev VM) the same round-trip
// stalls into the tens or hundreds of ms, and that stall is charged to
// whichever statement happened to be in flight. Publishing it separately is
// what keeps the per-stage table honest: a stage's number is only meaningful
// as (stage cost − this floor).
{
  const readState = openReadStateDb();
  const floor: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    await readState.query("select 1 as n").get<{ n: number }>();
    floor.push(performance.now() - t0);
  }
  const sorted = [...floor].sort((a, b) => a - b);
  console.log(
    `\n  ambient floor (bare 'select 1' round-trip on the readstate worker): min ${sorted[0]!.toFixed(2)}ms  p50 ${pct(floor, 50).toFixed(2)}ms  p95 ${pct(floor, 95).toFixed(2)}ms  max ${sorted[sorted.length - 1]!.toFixed(2)}ms`,
  );
  console.log(`FLOORJSON ${JSON.stringify({ min: Number(sorted[0]!.toFixed(2)), p50: Number(pct(floor, 50).toFixed(2)), p95: Number(pct(floor, 95).toFixed(2)), max: Number(sorted[sorted.length - 1]!.toFixed(2)) })}`);
}

await handle.close();
closeDb();
