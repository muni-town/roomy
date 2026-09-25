/**
 * Unit tests for the Roomy Pro members-role reconciliation sweep
 * (src/billing/proRoleReconcile.ts).
 *
 * Uses an in-memory SQLite DB (via openDb) with a real StreamManager set as
 * the singleton, so role events land in the event log and materialize into
 * the Roomy Space's per-space DB (member_roles). Polar fetches are stubbed —
 * real Polar is never hit.
 *
 * Covers: new subscriber added; lapsed tracked subscriber removed;
 * manually-added non-subscriber (not tracked by the sweep, so never removed)
 * untouched; no-op run writes nothing; Polar outage → no writes
 * (fail-safe — a stale/unknown state is never read as "not paying").
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid } from "@roomy-space/sdk";
import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { Router } from "../invalidation/router.ts";
import { StreamManager, setStreamManager, _resetStreamManager } from "../streams/StreamManager.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import {
  ROOMY_SPACE_DID,
  MEMBERS_ROLE_ID,
  reconcileProMembers,
} from "./proRoleReconcile.ts";
import { setPolar, type PolarConfig } from "./polar.ts";
import type { DbLike } from "../db/types.ts";

const CONFIG: PolarConfig = {
  endpoint: "https://sandbox-api.polar.sh/v1",
  accessToken: "polar_oat_test",
  roomyProProductId: "prod_roomy_pro",
  appOrigin: "https://roomy.space",
};

const SERVICE_DID = "did:web:api.roomy.space";
const ROOMY_SPACE = StreamDid.assert(ROOMY_SPACE_DID);

const SUB_A = "did:plc:sub-a";
const SUB_B = "did:plc:sub-b";
const LAPSED = "did:plc:sub-lapsed";
const MANUAL = "did:plc:manual-nonsub";

const realFetch = globalThis.fetch;

/** Stub global fetch for the Polar subscriptions list. */
function stubSubscribers(active: string[]): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json(
        {
          items: active.map((ext) => ({
            status: "active",
            product_id: CONFIG.roomyProProductId,
            customer: { external_id: ext },
          })),
          pagination: { total_count: active.length, max_page: 1 },
        },
        { status: 200 },
      ),
    )) as unknown as typeof fetch;
}

function stubPolarOutage(): void {
  globalThis.fetch = (() =>
    Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;
}

function resetFetch(): void {
  globalThis.fetch = realFetch;
}

/** Seed a member into the Members role of the Roomy Space. */
async function seedMemberInRole(did: string): Promise<void> {
  await openSpaceDb(ROOMY_SPACE_DID)
    .run(
      "insert into member_roles (user_id, role_id, stream_id) values (?, ?, ?)",
      did,
      MEMBERS_ROLE_ID,
      ROOMY_SPACE_DID,
    );
}

/** Seed a pro_role_grants tracking row for a DID. */
async function seedTracked(did: string): Promise<void> {
  await openReadStateDb()
    .run("insert into pro_role_grants (did, granted_at) values (?, ?)", did, Date.now());
}

async function membersInRole(): Promise<string[]> {
  const rows = await openSpaceDb(ROOMY_SPACE_DID)
    .query("select user_id from member_roles where role_id = ? and stream_id = ?")
    .all<{ user_id: string }>(MEMBERS_ROLE_ID, ROOMY_SPACE_DID);
  return rows.map((r) => r.user_id);
}

let db: DbLike;

beforeEach(async () => {
  closeDb();
  _resetEmbedSweeper();
  Router.resetInstance();
  _resetStreamManager();
  db = openDb({ path: ":memory:" });
  setStreamManager(
    new StreamManager(db, {
      appserverUrl: "http://test.example",
      getProfiles: undefined,
      // The sweep writes as the StreamManager's own DID; supply the service
      // DID here so it matches the DID the sendEvents endpoint authorizes.
      ownDid: SERVICE_DID,
    }),
  );
  setPolar(CONFIG);
});

afterEach(() => {
  resetFetch();
  setPolar(null);
  _resetStreamManager();
  closeDb();
  Router.resetInstance();
});

describe("reconcileProMembers", () => {
  test("new subscribers → added to Members role + tracked", async () => {
    stubSubscribers([SUB_A, SUB_B]);

    const res = await reconcileProMembers(openReadStateDb(), CONFIG);

    expect(res.failed).toBe(false);
    expect(new Set(res.added)).toEqual(new Set([SUB_A, SUB_B]));
    expect(res.removed).toEqual([]);
    expect(new Set(await membersInRole())).toEqual(new Set([SUB_A, SUB_B]));
  });

  test("lapsed tracked subscriber removed; untracked manual member untouched", async () => {
    // LAPSED was granted by the sweep and is in the role; its subscription
    // has lapsed → removed. MANUAL is in the role but was NEVER granted by
    // the sweep (manual grant) → left untouched even though not a subscriber.
    await seedTracked(LAPSED);
    await seedMemberInRole(LAPSED);
    await seedMemberInRole(MANUAL);

    // Only SUB_A is currently subscribed.
    stubSubscribers([SUB_A]);

    const res = await reconcileProMembers(openReadStateDb(), CONFIG);

    expect(res.removed).toEqual([LAPSED]);
    expect(res.added).toEqual([SUB_A]);
    expect(new Set(await membersInRole())).toEqual(new Set([SUB_A, MANUAL]));

    // LAPSED is tracked by no grant row once removed.
    const tracked = await openReadStateDb()
      .query("select did from pro_role_grants where did = ?")
      .get<{ did: string }>(LAPSED);
    expect(tracked).toBeNull();
  });

  test("no-op run writes no events", async () => {
    // First run adds SUB_A and tracks it.
    stubSubscribers([SUB_A]);
    await reconcileProMembers(openReadStateDb(), CONFIG);

    // Second identical run → nothing to do.
    const before = await db
      .query("select count(*) as n from stream_events")
      .get<{ n: number }>();
    const res = await reconcileProMembers(openReadStateDb(), CONFIG);
    const after = await db
      .query("select count(*) as n from stream_events")
      .get<{ n: number }>();

    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(res.failed).toBe(false);
    expect(after!.n).toBe(before!.n);
    expect(await membersInRole()).toEqual([SUB_A]);
  });

  test("Polar outage (5xx) → writes NOTHING (fail-safe)", async () => {
    // A tracked, in-role member whose sub only "looks" lapsed because Polar
    // is down. The sweep must NOT remove them.
    await seedTracked(SUB_A);
    await seedMemberInRole(SUB_A);

    stubPolarOutage();

    const res = await reconcileProMembers(openReadStateDb(), CONFIG);

    expect(res.failed).toBe(true);
    expect(res.added).toEqual([]);
    expect(res.removed).toEqual([]);
    expect(await membersInRole()).toEqual([SUB_A]);

    // Still tracked.
    const tracked = await openReadStateDb()
      .query("select did from pro_role_grants where did = ?")
      .get<{ did: string }>(SUB_A);
    expect(tracked?.did).toBe(SUB_A);
  });
});
