/**
 * reorderSpaces handler: per-user space ordering in the read-state DB.
 * The handler must validate membership, persist the order, and emit a
 * getSpaces invalidation signal.
 */

import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { reorderSpacesHandler } from "./space.roomy.space.reorderSpaces.ts";
import { Router } from "../invalidation/router.ts";

const USER = UserDid.assert("did:plc:reorder-user");
const SPACE_A = StreamDid.assert("did:web:space-a.example");
const SPACE_B = StreamDid.assert("did:web:space-b.example");
const SPACE_C = StreamDid.assert("did:web:space-c.example");

interface SpaceOrderRow {
  space_did: string;
  position: number;
}

async function readOrder(): Promise<SpaceOrderRow[]> {
  return openReadStateDb()
    .query(
      "select space_did, position from space_order where user_did = ? order by position asc",
    )
    .all<SpaceOrderRow>(USER);
}

beforeEach(async () => {
  closeDb();
  _resetHydrationInflight();
  Router.resetInstance();

  const db = openDb({ path: ":memory:" });

  // Seed membership intent for three joined spaces.
  for (const [i, space] of [SPACE_A, SPACE_B, SPACE_C].entries()) {
    await db
      .readState!()
      .run(
        `insert into user_space_membership
           (user_did, space_did, state, source, source_event_id, updated_at)
         values (?, ?, 'joined', 'seed', ?, ?)`,
        [USER, space, `01SEED${i}`, Date.now() - i],
      );
  }
});

afterEach(() => {
  closeDb();
  _resetHydrationInflight();
  Router.resetInstance();
});

describe("reorderSpaces", () => {
  test("persists the given order", async () => {
    await reorderSpacesHandler(
      {},
      { did: USER },
      { spaceIds: [SPACE_C, SPACE_A, SPACE_B] },
    );

    const rows = await readOrder();
    expect(rows.map((r) => r.space_did)).toEqual([SPACE_C, SPACE_A, SPACE_B]);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  test("replacing the order drops stale rows", async () => {
    await reorderSpacesHandler(
      {},
      { did: USER },
      { spaceIds: [SPACE_B, SPACE_A] },
    );
    await reorderSpacesHandler(
      {},
      { did: USER },
      { spaceIds: [SPACE_A, SPACE_C] },
    );

    const rows = await readOrder();
    expect(rows.map((r) => r.space_did)).toEqual([SPACE_A, SPACE_C]);
  });

  test("rejects a space the caller has not joined", async () => {
    const other = StreamDid.assert("did:web:not-joined.example");
    await expect(
      reorderSpacesHandler(
        {},
        { did: USER },
        { spaceIds: [SPACE_A, other] },
      ),
    ).rejects.toThrow(/not a member/);
  });

  test("rejects non-array or non-string spaceIds", async () => {
    await expect(
      reorderSpacesHandler({}, { did: USER }, { spaceIds: "nope" }),
    ).rejects.toThrow(/spaceIds/);
    await expect(
      reorderSpacesHandler({}, { did: USER }, { spaceIds: [SPACE_A, 42] }),
    ).rejects.toThrow(/spaceIds/);
  });

  test("requires authentication", async () => {
    await expect(
      reorderSpacesHandler({}, { did: null }, { spaceIds: [SPACE_A] }),
    ).rejects.toThrow(/Authentication required/);
  });

  test("emits a getSpaces invalidation for the caller", async () => {
    const router = new Router();
    Router.setInstance(router);
    const seen: unknown[] = [];
    router.subscribe((events) => seen.push(...events));

    await reorderSpacesHandler(
      {},
      { did: USER },
      { spaceIds: [SPACE_B, SPACE_C, SPACE_A] },
    );

    expect(seen).toEqual([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getSpaces",
          params: {},
          affectedUser: USER,
        },
      },
    ]);
  });
});
