#!/usr/bin/env bun
/**
 * Read-path latency probe, used as the A/B for the per-user membership read.
 *
 * `room.getMessages` and `space.getActivityFeed` (and 13 other read handlers)
 * used to open with `await hydrateUserMembership(userDid)`, whose only effect
 * was to `select space_did from user_space_membership where user_did = ? and
 * state = 'joined' order by updated_at desc` on the read-state worker and then
 * discard the result. Access decisions are taken separately from each space's
 * own DB (`requireRoomRead`/`requireSpaceAccess`), so the read was pure cost.
 *
 * This seeds a production-shaped read-state DB (a membership row per space the
 * caller has ever joined) and measures the two routes named above.
 *
 * Usage:
 *   APPSERVER_TEST_MODE=true RATE_LIMIT_DISABLED=true \
 *     bun run packages/appserver/perf/probe-membership.ts [--memberships 4382] [--iterations 200]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUlid } from "@roomy-space/sdk";
import { createAppserver } from "../src/appserver.ts";
import { testAuthVerifier } from "../src/xrpc/auth.ts";
import { closeDb, openDb, openSpaceDb, openGlobalDb, openReadStateDb } from "../src/db/db.ts";
import { _setAdminDids } from "../src/admin.ts";
import { _resetEmbedSweeper, stopEmbedSweeper } from "../src/embed/sweeper.ts";
import { _resetSearchIndexer, stopSearchIndexer } from "../src/search/indexer.ts";
import { _resetProfileStoreCache, _setTestGetProfiles } from "../src/queries/profileStore.ts";

const argv = process.argv;
const numArg = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const MEMBERSHIPS = numArg("memberships", 4382);
const ITERATIONS = numArg("iterations", 200);
const WARMUP = numArg("warmup", 20);
const LABEL = argv.includes("--label") ? (argv[argv.indexOf("--label") + 1] ?? "run") : "run";

const USER = "did:plc:probe-membership-user";
const SPACE = "did:plc:probe-membership-space";
const OTHER_SPACE_BASE = "did:plc:probe-space";

const dataDir = mkdtempSync(join(tmpdir(), "probe-membership-"));
process.env.DATA_DIR = dataDir;
_setAdminDids(["did:plc:probe-admin"]);
await stopEmbedSweeper();
await stopSearchIndexer();
closeDb();
_resetEmbedSweeper();
_resetSearchIndexer();
_resetProfileStoreCache();

openDb({ path: join(dataDir, "roomy-events.sqlite") });

_setTestGetProfiles(async () => []);
const handle = await createAppserver({
  authVerifier: testAuthVerifier,
  port: 0,
  dbPath: join(dataDir, "roomy-events.sqlite"),
  readStateDbPath: join(dataDir, "roomy-readstate.sqlite"),
  quiet: true,
  disableBackgroundWorkers: true,
  happyView: null,
});
const baseUrl = `http://localhost:${handle.port}`;

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]!;
};

// ─── Fixture ──────────────────────────────────────────────────────────────

async function post(events: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(`${baseUrl}/xrpc/space.roomy.space.sendEvents`, {
    method: "POST",
    headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
    body: JSON.stringify({ spaceId: SPACE, events }),
  });
  if (!res.ok) throw new Error(`sendEvents ${res.status}: ${await res.text()}`);
}

const globalDb = openGlobalDb();
const spaceDb = openSpaceDb(SPACE);
const readStateDb = openReadStateDb();

await globalDb.run("insert or ignore into entity_space (entity_id, space_did) values (?, ?)", [SPACE, SPACE]);
await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
await spaceDb.run(
  `insert or ignore into comp_space (entity, allow_public_join, allow_member_invites) values (?, ?, ?)`,
  [SPACE, 1, 1],
);
await spaceDb.run("insert or ignore into comp_info (entity, name) values (?, ?)", [SPACE, "Membership Probe Space"]);
await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, USER]);
await spaceDb.run("insert or ignore into comp_user (did, handle) values (?, ?)", [USER, null]);
await spaceDb.run("insert or ignore into edges (head, tail, label) values (?, ?, 'admin')", [SPACE, USER]);

// Production shape: this user has a membership row for every space they have
// ever joined, so the `order by updated_at desc` has real rows to sort.
const seed = await readStateDb.prepare(
  `insert or ignore into user_space_membership (user_did, space_did, state, source, source_event_id, updated_at)
   values (?, ?, 'joined', 'probe', ?, ?)`,
);
const seedStart = performance.now();
for (let i = 0; i < MEMBERSHIPS; i++) {
  await seed.run(USER, `${OTHER_SPACE_BASE}${i}`, newUlid(), Date.now() - i * 1000);
}
await seed.finalize();
console.log(
  `seeded ${MEMBERSHIPS} user_space_membership rows in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`,
);

const roomEvent = {
  $type: "space.roomy.room.createRoom.v0",
  id: newUlid(),
  kind: "space.roomy.channel",
  name: "probe-channel",
};
await post([roomEvent]);
const ROOM = roomEvent.id;

// Seed messages so getMessages/activityFeed have rows to return.
await post(
  Array.from({ length: 40 }, (_, i) => ({
    $type: "space.roomy.message.createMessage.v0",
    id: newUlid(),
    room: ROOM,
    body: {
      mimeType: "text/markdown",
      data: { $bytes: Buffer.from(`probe message ${i}`).toString("base64") },
    },
    extensions: {},
  })),
);

const rowCount = await readStateDb
  .query("select count(*) as n from user_space_membership where user_did = ?")
  .get<{ n: number }>([USER]);
console.log(`  user_space_membership rows for caller: ${rowCount?.n}`);

// Time the bare membership read on its own, so the report separates the query
// cost from its share of the request.
{
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    await readStateDb
      .query(
        `select space_did as id from user_space_membership where user_did = ? and state = 'joined' order by updated_at desc`,
      )
      .all<{ id: string }>([USER]);
  }
  console.log(`  bare membership read: ${((performance.now() - t0) / 50).toFixed(3)}ms/query`);
}

// ─── Measurement ──────────────────────────────────────────────────────────

const ROUTES = [
  { name: "room.getMessages", path: `/xrpc/space.roomy.room.getMessages?roomId=${encodeURIComponent(ROOM)}&limit=50` },
  { name: "space.getActivityFeed", path: `/xrpc/space.roomy.space.getActivityFeed?limit=50` },
];

async function hit(path: string): Promise<{ ms: number; status: number }> {
  const start = performance.now();
  const res = await fetch(`${baseUrl}${path}`, { headers: { "X-Test-Did": USER } });
  const ms = performance.now() - start;
  await res.arrayBuffer();
  return { ms, status: res.status };
}

console.log(`\n=== ${LABEL} ===`);
console.log(`  ${"route".padEnd(24)}${"p50".padStart(9)}${"p95".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}   status`);
const summary: Record<string, { p50: number; p95: number; p99: number; max: number }> = {};
for (const route of ROUTES) {
  for (let i = 0; i < WARMUP; i++) await hit(route.path);
  const ms: number[] = [];
  const statuses = new Map<number, number>();
  for (let i = 0; i < ITERATIONS; i++) {
    const r = await hit(route.path);
    ms.push(r.ms);
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  }
  const st = [...statuses.entries()].map(([k, v]) => `${k}x${v}`).join(" ");
  summary[route.name] = { p50: pct(ms, 50), p95: pct(ms, 95), p99: pct(ms, 99), max: pct(ms, 100) };
  const s = summary[route.name]!;
  console.log(
    `  ${route.name.padEnd(24)}${s.p50.toFixed(2).padStart(9)}${s.p95.toFixed(2).padStart(9)}${s.p99.toFixed(2).padStart(9)}${s.max.toFixed(2).padStart(9)}   ${st}`,
  );
}
console.log(`\nJSON ${JSON.stringify({ label: LABEL, memberships: MEMBERSHIPS, iterations: ITERATIONS, summary })}`);

await handle.close();
closeDb();
rmSync(dataDir, { recursive: true, force: true });
