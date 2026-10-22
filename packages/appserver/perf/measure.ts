#!/usr/bin/env bun
/**
 * Per-endpoint performance harness for the appserver.
 *
 * Measures latency per XRPC endpoint and outputs a structured report.
 * Auto-discovers endpoints from buildRouter — new endpoints are measured
 * automatically.
 *
 * Usage:
 *   APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true \
 *     bun run packages/appserver/perf/measure.ts
 *   ... --iterations=500 --warmup=20 --concurrency=10
 *
 * `RATE_LIMIT_DISABLED=true` is not optional in spirit: every endpoint is
 * called `warmup + iterations` times as one caller, so past a handful of
 * iterations the per-endpoint limit answers 429 and the table measures the
 * limiter rather than the handler. The limiters read the env at import time,
 * so it has to be set by the caller.
 *
 * Output:
 *   - Console table sorted by p95 descending
 *   - perf/results-<timestamp>.json
 */

import { createAppserver, getRegisteredNsids } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb } from "../src/db/db.ts";
import type { PooledDatabase } from "../src/db/pool.ts";
import { _resetEmbedSweeper } from "../src/embed/sweeper.ts";
import { _setAdminDids } from "../src/admin.ts";
import { newUlid } from "@roomy-space/sdk";

// ─── Config ────────────────────────────────────────────────────────────────

const ITERATIONS = parseInt(process.argv.find((a) => a.startsWith("--iterations="))?.split("=")[1] ?? "100", 10);
const WARMUP = parseInt(process.argv.find((a) => a.startsWith("--warmup="))?.split("=")[1] ?? "10", 10);
const CONCURRENCY = parseInt(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "0", 10);
const QUIET = process.argv.includes("--quiet");

// ─── Types ─────────────────────────────────────────────────────────────────

interface EndpointResult {
  nsid: string;
  kind: string;
  count: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  mean_ms: number;
  errors: number;
  /** Only present in concurrency mode. */
  throughput_rps?: number;
  /** Only present in concurrency mode. */
  concurrency?: number;
}

interface EndpointDef {
  nsid: string;
  kind: string;
  /** Build the request for an iteration: returns [method, path, body?]. */
  buildRequest: (fixture: Fixture, iteration: number) => { method: string; path: string; body?: unknown };
  /** Whether this endpoint needs auth. */
  needsAuth: boolean;
  /** Whether this is a write endpoint that needs unique keys per iteration. */
  isWrite: boolean;
  /** For write endpoints, a function to reset state before each measured iteration. */
  reset?: (fixture: Fixture) => void | Promise<void>;
  /**
   * For write endpoints that consume fixture state, a function that writes the
   * seeded state back once the endpoint is done being measured. The endpoints
   * measured after this one must start from the fixture, not from this
   * endpoint's side effect.
   */
  restore?: (fixture: Fixture) => void | Promise<void>;
}

/**
 * Endpoints whose auth guard requires a space or deployment admin. Every other
 * endpoint is measured as the plain member (`Fixture.userDid`).
 */
const ADMIN_ONLY_NSIDS: Readonly<Record<string, true>> = {
  "space.roomy.admin.connectSpace": true,
  "space.roomy.admin.materializeSpace": true,
  "space.roomy.space.setHandle": true,
  "space.roomy.space.sendEvents": true,
};

/** The seeded membership facts a write endpoint may consume: both `member`
 *  edge directions and the durable join intent `getSpaces` reads. */
const MEMBER_EDGE_SQL = "insert or ignore into edges (head, tail, label) values (?, ?, 'member')";
const JOINED_MEMBERSHIP_SQL = `insert into user_space_membership
     (user_did, space_did, state, source, source_event_id)
   values (?, ?, 'joined', 'perf', ?)
   on conflict(user_did, space_did) do update set state = excluded.state`;
const READ_POSITION_SQL = `insert or replace into read_positions
     (user_did, room_id, space_did, seen_up_to, updated_at)
   values (?, ?, ?, ?, ?)`;

interface Fixture {
  db: PooledDatabase;
  baseUrl: string;
  userDid: string;
  adminDid: string;
  spaceId: string;
  roomId: string;
  msgId: string;
  msgId2: string;
  roleId: string;
  inviteToken: string;
  secondUserDid: string;
}

// ─── Fixture seeding ────────────────────────────────────────────────────────

/**
 * Seed the rows the measured endpoints read, through the pool's routed
 * handles: space data (entities, comp_*, edges, roles, activity) in the
 * space's own DB, durable membership intent and read positions in the
 * read-state DB, and the entity→space index in the global DB. The reads that
 * resolve a room or message back to its space go through `entity_space`, so
 * every seeded entity needs an entry there.
 */
async function seedFixture(db: PooledDatabase): Promise<Fixture> {
  const userDid = "did:plc:perf-user";
  const adminDid = "did:plc:perf-admin";
  const spaceId = "did:web:perf-space.example";
  const roomId = newUlid();
  const msgId = newUlid();
  const msgId2 = newUlid();
  const roleId = newUlid();
  const inviteToken = "perf-invite-token";
  const secondUserDid = "did:plc:perf-user2";

  const space = db.forSpace(spaceId);
  const global = db.global();
  const readState = db.readState();

  // ── Space ──
  await space.run("insert or ignore into entities (id, stream_id) values (?, ?)", spaceId, spaceId);
  await space.run("insert or ignore into comp_space (entity, allow_public_join, allow_member_invites) values (?, ?, ?)", spaceId, 1, 1);
  await space.run("insert or ignore into comp_info (entity, name) values (?, ?)", spaceId, "Perf Test Space");
  await global.run("insert or ignore into entity_space (entity_id, space_did) values (?, ?)", spaceId, spaceId);

  // ── Users ──
  for (const did of [userDid, adminDid, secondUserDid]) {
    await space.run("insert or ignore into entities (id, stream_id) values (?, ?)", did, did);
    await space.run("insert or ignore into comp_user (did, handle) values (?, ?)", did, null);
  }

  // ── Memberships ──
  for (const did of [userDid, adminDid, secondUserDid]) {
    await space.run(MEMBER_EDGE_SQL, spaceId, did);
    await space.run(MEMBER_EDGE_SQL, did, spaceId);
  }

  // Admin edge for admin user
  await space.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", spaceId, adminDid);
  await space.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", adminDid, spaceId);

  // ── Join intent ──
  await global.run("insert or ignore into edges (head, tail, label) values (?, ?, 'joinedSpace')", userDid, spaceId);
  await readState.run(JOINED_MEMBERSHIP_SQL, userDid, spaceId, `01PERF${spaceId}`);

  // ── Room ──
  await space.run("insert or ignore into entities (id, stream_id) values (?, ?)", roomId, spaceId);
  await space.run("insert or ignore into comp_room (entity, label) values (?, ?)", roomId, "space.roomy.channel");
  await global.run("insert or ignore into entity_space (entity_id, space_did) values (?, ?)", roomId, spaceId);

  // ── Messages ──
  for (const mid of [msgId, msgId2]) {
    await space.run("insert or ignore into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", mid, spaceId, roomId, mid);
    await space.run("insert or ignore into comp_content (entity, mime_type, data, last_edit) values (?, 'text/html', ?, ?)", mid, new TextEncoder().encode("<p>hello</p>"), mid);
    await global.run("insert or ignore into entity_space (entity_id, space_did) values (?, ?)", mid, spaceId);
  }

  // ── Role ──
  await space.run("insert into roles (id, stream_id, name) values (?, ?, ?)", roleId, spaceId, "Perf Role");

  // ── Invite ──
  await space.run("insert into comp_invite (entity, token, created_by_did, event_ulid) values (?, ?, ?, ?)", spaceId, inviteToken, userDid, newUlid());

  // ── Activity feed item ──
  await space.run("insert into activity_item (room_id, space_id, last_activity_at, recent_message_ids) values (?, ?, ?, ?)", roomId, spaceId, Date.now(), "[]");

  // ── Read position ──
  await readState.run(READ_POSITION_SQL, userDid, roomId, spaceId, msgId, Date.now());

  return {
    db,
    baseUrl: "", // filled after server starts
    userDid,
    adminDid,
    spaceId,
    roomId,
    msgId,
    msgId2,
    roleId,
    inviteToken,
    secondUserDid,
  };
}



// ─── Endpoint definitions ──────────────────────────────────────────────────

function buildEndpoints(fixture: Fixture): EndpointDef[] {
  const { spaceId, roomId, msgId, msgId2, roleId, inviteToken, userDid, adminDid } = fixture;

  return [
    // ── Queries (GET) ──
    {
      nsid: "space.roomy.auth.getConnectionTicket",
      kind: "procedure",
      buildRequest: () => ({ method: "POST", path: "/xrpc/space.roomy.auth.getConnectionTicket", body: {} }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.space.getSpaces",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: "/xrpc/space.roomy.space.getSpaces" }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.space.getMetadata",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.space.getMetadata?spaceId=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.space.getMembers",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.space.getMembers?spaceId=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.space.getThreads",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.space.getThreads?spaceId=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.space.getRoles",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.space.getRoles?spaceId=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.space.getInvites",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.space.getInvites?spaceId=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.space.getActivityFeed",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.space.getActivityFeed?spaceId=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.room.getMetadata",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.room.getMetadata?roomId=${encodeURIComponent(roomId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.room.getThreads",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.room.getThreads?roomId=${encodeURIComponent(roomId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.room.getMessages",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.room.getMessages?roomId=${encodeURIComponent(roomId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.message.getMessage",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.message.getMessage?messageId=${encodeURIComponent(msgId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.message.getReactions",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.message.getReactions?messageId=${encodeURIComponent(msgId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    // ── Admin queries (GET) ──
    {
      nsid: "space.roomy.admin.connectSpace",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.admin.connectSpace?did=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    {
      nsid: "space.roomy.admin.materializeSpace",
      kind: "query",
      buildRequest: () => ({ method: "GET", path: `/xrpc/space.roomy.admin.materializeSpace?did=${encodeURIComponent(spaceId)}` }),
      needsAuth: true,
      isWrite: false,
    },
    // ── Procedures (POST) ──
    {
      nsid: "space.roomy.room.updateSeen",
      kind: "procedure",
      buildRequest: () => ({ method: "POST", path: "/xrpc/space.roomy.room.updateSeen", body: { roomId, seenUpTo: msgId2 } }),
      needsAuth: true,
      isWrite: true,
      reset: async (f) => {
        await f.db.readState().run(
          "delete from read_positions where user_did = ? and room_id = ?",
          userDid,
          roomId,
        );
      },
      restore: async (f) => {
        await f.db
          .readState()
          .run(READ_POSITION_SQL, userDid, roomId, spaceId, msgId, Date.now());
      },
    },
    {
      nsid: "space.roomy.space.createSpace",
      kind: "procedure",
      buildRequest: (_f, iteration) => ({
        method: "POST",
        path: "/xrpc/space.roomy.space.createSpace",
        body: { name: `Perf Space ${iteration}` },
      }),
      needsAuth: true,
      isWrite: true,
      // Each iteration uses a unique name, no reset needed.
    },
    {
      nsid: "space.roomy.space.joinSpace",
      kind: "procedure",
      buildRequest: () => ({ method: "POST", path: "/xrpc/space.roomy.space.joinSpace", body: { spaceId, inviteToken } }),
      needsAuth: true,
      isWrite: true,
      // joinSpace is idempotent for already-joined users, so no reset needed.
    },
    {
      nsid: "space.roomy.space.leaveSpace",
      kind: "procedure",
      buildRequest: () => ({ method: "POST", path: "/xrpc/space.roomy.space.leaveSpace", body: { spaceId } }),
      needsAuth: true,
      isWrite: true,
      reset: async (f) => {
        const space = f.db.forSpace(spaceId);
        await space.run(MEMBER_EDGE_SQL, spaceId, userDid);
        await space.run(MEMBER_EDGE_SQL, userDid, spaceId);
        await f.db
          .readState()
          .run(JOINED_MEMBERSHIP_SQL, userDid, spaceId, `01PERF${spaceId}`);
      },
      restore: async (f) => {
        const space = f.db.forSpace(spaceId);
        await space.run(MEMBER_EDGE_SQL, spaceId, userDid);
        await space.run(MEMBER_EDGE_SQL, userDid, spaceId);
        await f.db
          .readState()
          .run(JOINED_MEMBERSHIP_SQL, userDid, spaceId, `01PERF${spaceId}`);
      },
    },
    {
      nsid: "space.roomy.space.setHandle",
      kind: "procedure",
      buildRequest: (_f, iteration) => ({
        method: "POST",
        path: "/xrpc/space.roomy.space.setHandle",
        body: { spaceId, handle: `perf-handle-${iteration}` },
      }),
      needsAuth: true,
      isWrite: true,
      // Each iteration uses a unique handle, no reset needed.
    },
    {
      nsid: "space.roomy.space.sendEvents",
      kind: "procedure",
      buildRequest: () => ({
        method: "POST",
        path: "/xrpc/space.roomy.space.sendEvents",
        body: {
          spaceId,
          events: [{
            $type: "space.roomy.room.createRoom.v0",
            id: newUlid(),
            kind: "space.roomy.channel",
            name: "perf-channel",
          }],
        },
      }),
      needsAuth: true,
      isWrite: true,
      // Each iteration uses a unique channel ID, no reset needed.
    },
  ];
}

// ─── Stats computation ──────────────────────────────────────────────────────

function computeStats(durations: number[], errors: number): Omit<EndpointResult, "nsid" | "kind" | "throughput_rps" | "concurrency"> {
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);

  const percentile = (p: number) => {
    const idx = Math.ceil((p / 100) * n) - 1;
    return sorted[Math.max(0, Math.min(idx, n - 1))]!;
  };

  return {
    count: n,
    min_ms: sorted[0]!,
    p50_ms: percentile(50),
    p95_ms: percentile(95),
    p99_ms: percentile(99),
    max_ms: sorted[n - 1]!,
    mean_ms: n > 0 ? sum / n : 0,
    errors,
  };
}

/**
 * The caller a measured request authenticates as: the fixture's space admin
 * for endpoints only an admin may call, the plain member otherwise.
 */
function callerDid(def: EndpointDef, fixture: Fixture): string {
  return ADMIN_ONLY_NSIDS[def.nsid] === true ? fixture.adminDid : fixture.userDid;
}

// ─── Sequential measurement ────────────────────────────────────────────────

async function measureSequential(
  def: EndpointDef,
  fixture: Fixture,
  iterations: number,
  warmup: number,
): Promise<EndpointResult> {
  const authDid = callerDid(def, fixture);
  const durations: number[] = [];
  let errors = 0;

  for (let i = 0; i < warmup + iterations; i++) {
    const { method, path, body } = def.buildRequest(fixture, i);

    // Reset write endpoints between iterations (after warmup)
    if (i >= warmup && def.isWrite && def.reset) {
      await def.reset(fixture);
    }

    const url = `${fixture.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "X-Test-Did": authDid,
        "Content-Type": "application/json",
      },
    };
    if (body && method === "POST") {
      init.body = JSON.stringify(body);
    }

    const start = performance.now();
    try {
      const res = await fetch(url, init);
      // Only 5xx counts: the harness measures handler latency, and a 4xx is
      // the fixture's answer (an endpoint whose input the fixture does not
      // satisfy) rather than a failure of the code under measurement.
      if (res.status >= 500) errors++;
    } catch {
      errors++;
    }
    const elapsed = performance.now() - start;

    if (i >= warmup) {
      durations.push(elapsed);
    }
  }

  // Leave the fixture as seeded for the endpoints measured after this one.
  if (def.isWrite && def.restore) await def.restore(fixture);

  return {
    nsid: def.nsid,
    kind: def.kind,
    ...computeStats(durations, errors),
  };
}

// ─── Concurrent measurement ────────────────────────────────────────────────

async function measureConcurrent(
  def: EndpointDef,
  fixture: Fixture,
  iterations: number,
  warmup: number,
  concurrency: number,
): Promise<EndpointResult> {
  const authDid = callerDid(def, fixture);
  const durations: number[] = [];
  let errors = 0;

  // Warmup sequentially
  for (let i = 0; i < warmup; i++) {
    const { method, path, body } = def.buildRequest(fixture, i);
    const url = `${fixture.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "X-Test-Did": authDid,
        "Content-Type": "application/json",
      },
    };
    if (body && method === "POST") {
      init.body = JSON.stringify(body);
    }
    await fetch(url, init);
  }

  // Fire concurrent batches
  const batchSize = concurrency;
  for (let offset = 0; offset < iterations; offset += batchSize) {
    const batch = Math.min(batchSize, iterations - offset);
    const batchDurations = new Array<number>(batch);

    const promises = Array.from({ length: batch }, async (_, j) => {
      const idx = offset + j;
      if (def.isWrite && def.reset) {
        await def.reset(fixture);
      }
      const { method, path, body } = def.buildRequest(fixture, idx);
      const url = `${fixture.baseUrl}${path}`;
      const init: RequestInit = {
        method,
        headers: {
          "X-Test-Did": authDid,
          "Content-Type": "application/json",
        },
      };
      if (body && method === "POST") {
        init.body = JSON.stringify(body);
      }

      const start = performance.now();
      try {
        const res = await fetch(url, init);
        if (res.status >= 500) errors++;
      } catch {
        errors++;
      }
      batchDurations[j] = performance.now() - start;
    });

    await Promise.all(promises);
    durations.push(...batchDurations);
  }

  // Leave the fixture as seeded for the endpoints measured after this one.
  if (def.isWrite && def.restore) await def.restore(fixture);

  const totalTime = durations.reduce((a, b) => a + b, 0);
  const throughput = totalTime > 0 ? (durations.length / totalTime) * 1000 : 0;

  return {
    nsid: def.nsid,
    kind: def.kind,
    ...computeStats(durations, errors),
    throughput_rps: Math.round(throughput * 10) / 10,
    concurrency,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Guard: refuse to run without test mode
  if (process.env.APPSERVER_TEST_MODE !== "true") {
    console.error("ERROR: APPSERVER_TEST_MODE must be 'true' to run the perf harness.");
    console.error("Set it and re-run:");
    console.error("  APPSERVER_TEST_MODE=true bun run packages/appserver/perf/measure.ts");
    process.exit(1);
  }

  // Set admin DIDs for admin endpoints
  const adminDid = "did:plc:perf-admin";
  _setAdminDids([adminDid]);

  // Reset singletons
  closeDb();
  _resetEmbedSweeper();

  // Open in-memory DB
  const db = openDb({ path: ":memory:" });

  // Start appserver
  const handle = await createAppserver({
    authVerifier: testAuthVerifier,
    port: 0,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    // The measurement is the request path alone: no background loop may run
    // against the in-memory DB while a request is being timed.
    disableBackgroundWorkers: true,
    quiet: true,
  });

  const baseUrl = `http://localhost:${handle.port}`;

  // Seed fixture
  const fixture = await seedFixture(db);
  fixture.baseUrl = baseUrl;

  // Discover endpoints
  const registered = getRegisteredNsids();
  const endpointDefs = buildEndpoints(fixture);

  // Build a map for quick lookup
  const defMap = new Map(endpointDefs.map((d) => [d.nsid, d]));

  // Filter to only registered endpoints that we have definitions for
  const toMeasure = registered
    .filter((r) => defMap.has(r.nsid))
    .map((r) => defMap.get(r.nsid)!);

  const skipped = registered.filter((r) => !defMap.has(r.nsid));
  if (skipped.length > 0 && !QUIET) {
    console.log(`Skipping ${skipped.length} endpoint(s) with no perf definition:`);
    for (const s of skipped) {
      console.log(`  - ${s.nsid} (${s.kind})`);
    }
  }

  if (toMeasure.length === 0) {
    console.error("No measurable endpoints found.");
    await handle.close();
    closeDb();
    process.exit(1);
  }

  if (!QUIET) {
    console.log(`Measuring ${toMeasure.length} endpoints:`);
    console.log(`  Iterations: ${ITERATIONS}, Warmup: ${WARMUP}`);
    if (CONCURRENCY > 0) {
      console.log(`  Concurrency: ${CONCURRENCY}`);
    }
    console.log("");
  }

  // Measure each endpoint
  const results: EndpointResult[] = [];
  for (const def of toMeasure) {
    if (!QUIET) {
      process.stdout.write(`  ${def.nsid}... `);
    }

    const result = CONCURRENCY > 0
      ? await measureConcurrent(def, fixture, ITERATIONS, WARMUP, CONCURRENCY)
      : await measureSequential(def, fixture, ITERATIONS, WARMUP);

    results.push(result);

    if (!QUIET) {
      process.stdout.write(`p50=${result.p50_ms.toFixed(2)}ms p95=${result.p95_ms.toFixed(2)}ms p99=${result.p99_ms.toFixed(2)}ms\n`);
    }
  }

  // Sort by p95 descending
  results.sort((a, b) => b.p95_ms - a.p95_ms);

  // Print table
  console.log("\n── Per-Endpoint Latency (sorted by p95) ──\n");
  const header = `${"Endpoint".padEnd(50)} ${"Kind".padEnd(12)} ${"Count".padEnd(6)} ${"Min".padEnd(8)} ${"p50".padEnd(8)} ${"p95".padEnd(8)} ${"p99".padEnd(8)} ${"Max".padEnd(8)} ${"Mean".padEnd(8)} ${"Errors".padEnd(6)}`;
  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of results) {
    const line = [
      r.nsid.padEnd(50),
      r.kind.padEnd(12),
      String(r.count).padEnd(6),
      r.min_ms.toFixed(2).padStart(7) + " ",
      r.p50_ms.toFixed(2).padStart(7) + " ",
      r.p95_ms.toFixed(2).padStart(7) + " ",
      r.p99_ms.toFixed(2).padStart(7) + " ",
      r.max_ms.toFixed(2).padStart(7) + " ",
      r.mean_ms.toFixed(2).padStart(7) + " ",
      String(r.errors).padEnd(6),
    ].join(" ");
    console.log(line);
  }

  if (CONCURRENCY > 0) {
    console.log("\n── Throughput ──\n");
    const tpHeader = `${"Endpoint".padEnd(50)} ${"Throughput (req/s)".padEnd(20)} ${"Concurrency".padEnd(12)}`;
    console.log(tpHeader);
    console.log("-".repeat(tpHeader.length));
    for (const r of results) {
      if (r.throughput_rps !== undefined) {
        const line = [
          r.nsid.padEnd(50),
          String(r.throughput_rps).padStart(19) + " ",
          String(r.concurrency).padEnd(12),
        ].join(" ");
        console.log(line);
      }
    }
  }

  // Write results JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `${import.meta.dir}/results-${timestamp}.json`;
  const output = {
    timestamp: new Date().toISOString(),
    config: { iterations: ITERATIONS, warmup: WARMUP, concurrency: CONCURRENCY },
    endpoints: results,
  };
  await Bun.write(outPath, JSON.stringify(output, null, 2));

  console.log(`\nResults written to ${outPath}`);

  // Cleanup
  await handle.close();
  closeDb();
  _resetEmbedSweeper();
}

await main();
