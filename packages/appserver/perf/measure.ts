#!/usr/bin/env bun
/**
 * Per-endpoint performance harness for the appserver.
 *
 * Measures latency per XRPC endpoint and outputs a structured report.
 * Auto-discovers endpoints from buildRouter — new endpoints are measured
 * automatically.
 *
 * Usage:
 *   bun run packages/appserver/perf/measure.ts
 *   bun run packages/appserver/perf/measure.ts --iterations 500 --warmup 20 --concurrency 10
 *
 * Output:
 *   - Console table sorted by p95 descending
 *   - perf/results-<timestamp>.json
 */

import { createAppserver, getRegisteredNsids } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb } from "../src/db/db.ts";
import { closeReadStateDb } from "../src/db/readStateDb.ts";
import { _resetMaterializerRegistry } from "../src/materialization/registry.ts";
import { _resetHydrationInflight } from "../src/hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../src/embed/sweeper.ts";
import { getOrCreateMaterializer } from "../src/materialization/registry.ts";
import { _setAdminDids } from "../src/admin.ts";
import { newUlid, type StreamDid } from "@roomy-space/sdk";
import type { Database } from "bun:sqlite";

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
  /** Build the request: returns [method, path, body?]. */
  buildRequest: (fixture: Fixture) => { method: string; path: string; body?: unknown };
  /** Whether this endpoint needs auth. */
  needsAuth: boolean;
  /** Whether this is a write endpoint that needs unique keys per iteration. */
  isWrite: boolean;
  /** For write endpoints, a function to reset state between iterations. */
  reset?: (fixture: Fixture, iteration: number) => void;
}

interface Fixture {
  db: Database;
  baseUrl: string;
  userDid: string;
  adminDid: string;
  spaceId: string;
  roomId: string;
  msgId: string;
  msgId2: string;
  roleId: string;
  inviteToken: string;
  personalStreamDid: string;
  secondUserDid: string;
}

// ─── Fixture seeding ────────────────────────────────────────────────────────

function seedFixture(db: Database): Fixture {
  const userDid = "did:plc:perf-user";
  const adminDid = "did:plc:perf-admin";
  const spaceId = "did:web:perf-space.example";
  const roomId = newUlid();
  const msgId = newUlid();
  const msgId2 = newUlid();
  const roleId = newUlid();
  const inviteToken = "perf-invite-token";
  const personalStreamDid = "did:web:perf-personal.example";
  const secondUserDid = "did:plc:perf-user2";

  // ── Space ──
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  db.run("insert or ignore into comp_space (entity, handle, allow_public_join, allow_member_invites) values (?, ?, ?, ?)", [spaceId, null, 1, 1]);
  db.run("insert or ignore into comp_info (entity, name) values (?, ?)", [spaceId, "Perf Test Space"]);

  // ── Users ──
  for (const did of [userDid, adminDid, secondUserDid]) {
    db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
    db.run("insert or ignore into comp_user (did, handle) values (?, ?)", [did, null]);
  }

  // ── Memberships ──
  for (const did of [userDid, adminDid, secondUserDid]) {
    db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'member')", [spaceId, did]);
    db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'member')", [did, spaceId]);
  }

  // Admin edge for admin user
  db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", [spaceId, adminDid]);
  db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", [adminDid, spaceId]);

  // ── Personal stream ──
  db.run("insert or ignore into comp_user_personal_stream (user_did, personal_stream_did, resolved_at) values (?, ?, ?)", [userDid, personalStreamDid, 0]);
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [personalStreamDid, personalStreamDid]);
  db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'joinedSpace')", [personalStreamDid, spaceId]);

  // ── Room ──
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [roomId, spaceId]);
  db.run("insert or ignore into comp_room (entity, label) values (?, ?)", [roomId, "space.roomy.channel"]);

  // ── Messages ──
  for (const mid of [msgId, msgId2]) {
    db.run("insert or ignore into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [mid, spaceId, roomId, mid]);
    db.run("insert or ignore into comp_content (entity, mime_type, data, last_edit) values (?, 'text/html', ?, ?)", [mid, new TextEncoder().encode("<p>hello</p>"), mid]);
  }

  // ── Role ──
  db.run("insert into roles (id, stream_id, name) values (?, ?, ?)", [roleId, spaceId, "Perf Role"]);

  // ── Invite ──
  db.run("insert into comp_invite (entity, token, created_by_did, event_ulid) values (?, ?, ?, ?)", [spaceId, inviteToken, userDid, newUlid()]);

  // ── Activity feed item ──
  db.run("insert into activity_item (room_id, space_id, last_activity_at, recent_message_ids) values (?, ?, ?, ?)", [roomId, spaceId, Date.now(), "[]"]);

  // ── Read position ──
  db.run("insert or ignore into readstate.read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)", [userDid, roomId, msgId, 0]);

  return {
    db, baseUrl: "", // filled after server starts
    userDid, adminDid, spaceId, roomId, msgId, msgId2, roleId, inviteToken, personalStreamDid, secondUserDid,
  };
}

/**
 * Pre-create a fake materializer that resolves immediately with no data.
 * This prevents handlers from trying to connect to Leaf.
 */
function instantSpace(streamDid: string) {
  return {
    streamDid,
    sendEvent: async () => {},
    fetchRooms: async () => [],
    fetchEvents: async () => ({ events: [], cursor: 0 }),
    subscribe: async () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true as const, value: undefined }),
        };
      },
    }),
    close: () => {},
  };
}

async function preWarmMaterializer(streamDid: string): Promise<void> {
  const db = openDb();
  await getOrCreateMaterializer(streamDid as unknown as StreamDid, {
    db,
    getConnectedSpace: () => Promise.resolve(instantSpace(streamDid)),
    invalidationRouter: null,
  });
}

// ─── Endpoint definitions ──────────────────────────────────────────────────

function buildEndpoints(fixture: Fixture): EndpointDef[] {
  const { spaceId, roomId, msgId, msgId2, roleId, inviteToken, userDid, adminDid } = fixture;

  return [
    // ── Queries (GET) ──
    {
      nsid: "space.roomy.auth.getConnectionTicket",
      kind: "procedure",
      buildRequest: () => ({ method: "POST", path: "/xrpc/space.roomy.auth.getConnectionTicket" }),
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
      reset: (f, _i) => {
        f.db.run("delete from readstate.read_positions where user_did = ? and room_id = ?", [userDid, roomId]);
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
      reset: (f, _i) => {
        // Re-add membership after leave
        f.db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'member')", [spaceId, userDid]);
        f.db.run("insert or ignore into edges (head, tail, label) values (?, ?, 'member')", [userDid, spaceId]);
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
            $type: "space.roomy.channel.createChannel.v0",
            id: newUlid(),
            name: "perf-channel",
            label: "space.roomy.channel",
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

// ─── Sequential measurement ────────────────────────────────────────────────

async function measureSequential(
  def: EndpointDef,
  fixture: Fixture,
  iterations: number,
  warmup: number,
): Promise<EndpointResult> {
  const authDid = def.nsid.startsWith("space.roomy.admin.") ? fixture.adminDid : fixture.userDid;
  const durations: number[] = [];
  let errors = 0;

  for (let i = 0; i < warmup + iterations; i++) {
    const { method, path, body } = def.buildRequest(fixture, i);

    // Reset write endpoints between iterations (after warmup)
    if (i >= warmup && def.isWrite && def.reset) {
      def.reset(fixture, i);
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
      if (!res.ok && res.status !== 400 && res.status !== 401 && res.status !== 403 && res.status !== 404) {
        // Some endpoints return 4xx for expected reasons (e.g. admin endpoints
        // with disabled backfill). Only count 5xx as errors.
        if (res.status >= 500) errors++;
      }
    } catch {
      errors++;
    }
    const elapsed = performance.now() - start;

    if (i >= warmup) {
      durations.push(elapsed);
    }
  }

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
  const authDid = def.nsid.startsWith("space.roomy.admin.") ? fixture.adminDid : fixture.userDid;
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
        def.reset(fixture, idx);
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
  closeReadStateDb();
  _resetMaterializerRegistry();
  _resetHydrationInflight();
  _resetEmbedSweeper();

  // Open in-memory DB
  const db = openDb({ path: ":memory:" });

  // Start appserver
  const handle = createAppserver({
    authVerifier: testAuthVerifier,
    port: 0,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    backfillMode: "disabled",
    quiet: true,
  });

  const baseUrl = `http://localhost:${handle.port}`;

  // Seed fixture
  const fixture = seedFixture(db);

  // Pre-warm materializers so handlers don't try to connect to Leaf
  await preWarmMaterializer(fixture.personalStreamDid);
  await preWarmMaterializer(fixture.spaceId);
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
    handle.close();
    closeDb();
    closeReadStateDb();
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
  handle.close();
  closeDb();
  closeReadStateDb();
  _resetMaterializerRegistry();
  _resetHydrationInflight();
  _resetEmbedSweeper();
}

await main();
