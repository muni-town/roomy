/**
 * refreshBlocks handler: the immediate path after an in-app block.
 *
 * The block record is already in the user's repo by the time this runs, so the
 * handler's whole job is to make the appserver notice — refetch the caller's set
 * and drop the block's subject's cached set, which is what makes the mutual
 * direction take effect without waiting for a cache expiry.
 *
 * The PDS is stubbed: these tests are about the handler's effect on stored state
 * and on the memos, not about the network, which `userBlocks.test.ts` covers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UserDid } from "@roomy-space/sdk";
import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import {
  _setTestFetchBlockRecords,
  type BlockRecord,
} from "../materialization/blocks.ts";
import {
  _resetBlockCaches,
  blocks,
  hiddenBy,
} from "../queries/userBlocks.ts";
import { refreshBlocksHandler } from "./space.roomy.user.refreshBlocks.ts";

const ALICE = UserDid.assert("did:plc:alice");
const BOB = UserDid.assert("did:plc:bob");

/** The blocks the stubbed PDS reports for each account. */
let repos: Map<string, BlockRecord[]>;

beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetBlockCaches();
  repos = new Map();
  _setTestFetchBlockRecords(async (did) => repos.get(did) ?? []);
});

afterEach(() => {
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  closeDb();
});

function serve(did: string, subjects: string[]): void {
  repos.set(
    did,
    subjects.map((subject) => ({ subject, source: "roomy", createdAt: null })),
  );
}

describe("refreshBlocks", () => {
  test("an unauthenticated caller is refused", async () => {
    await expect(
      refreshBlocksHandler({}, { did: null }, {}),
    ).rejects.toThrow(/Authentication required/);
  });

  test("a subject that is not a DID is rejected rather than silently ignored", async () => {
    await expect(
      refreshBlocksHandler({}, { did: ALICE }, { subject: "not-a-did" }),
    ).rejects.toThrow(/Invalid block subject/);
  });

  test("the caller's freshly written block is stored and visible to the next read", async () => {
    serve(ALICE, [BOB]);

    await refreshBlocksHandler({}, { did: ALICE }, {});

    const rows = await openReadStateDb()
      .query("select blocked_did from user_blocks where user_did = ?")
      .all<{ blocked_did: string }>([ALICE]);
    expect(rows.map((r) => r.blocked_did)).toEqual([BOB]);
    expect([...(await blocks(ALICE))]).toEqual([BOB]);
  });

  test("a block written before this call is dropped once the repo no longer holds it", async () => {
    serve(ALICE, [BOB]);
    await refreshBlocksHandler({}, { did: ALICE }, {});
    expect([...(await blocks(ALICE))]).toEqual([BOB]);

    // Unblocked: the record is gone from the repo.
    serve(ALICE, []);
    await refreshBlocksHandler({}, { did: ALICE }, {});
    expect([...(await blocks(ALICE))]).toEqual([]);
  });

  /**
   * The mutual case, which is the reason the body names a subject at all: the
   * blocked account's cached set has to go too, or they keep reading the blocker
   * until the TTL expires.
   */
  test("the block's subject has their cached set dropped too", async () => {
    // B's view is warmed while nobody has blocked them, so the memo the
    // invalidation has to clear is the empty one.
    expect([...(await hiddenBy(BOB))]).toEqual([]);

    // A now blocks B. B's own repos are untouched — the evidence is in A's.
    serve(ALICE, [BOB]);
    await refreshBlocksHandler({}, { did: ALICE }, { subject: BOB });

    const bRows = await openReadStateDb()
      .query("select blocked_did from user_blocks where user_did = ?")
      .all<{ blocked_did: string }>([BOB]);
    expect(bRows).toEqual([]);
    expect([...(await hiddenBy(BOB))]).toEqual([ALICE]);
  });
});
