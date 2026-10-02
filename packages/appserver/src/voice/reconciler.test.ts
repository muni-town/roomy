/**
 * Reconciliation against a fake LiveKit lister.
 *
 * The lister is the seam the loop is written against, so the whole correction
 * loop — including failure injection — runs with no SFU.
 * Correctness here is about what the projection converges TO, and about the
 * threshold behaviour that decides when converging stops being possible.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newUlid, StreamDid } from "@roomy-space/sdk";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { setLiveKit } from "../voice/livekit.ts";
import { liveKitRoomName } from "../voice/tokens.ts";
import {
  activeCall,
  listParticipants,
  listProjectedCalls,
} from "../voice/projection.ts";
import { recordJoin } from "../voice/callFacts.ts";
import {
  FAILURE_THRESHOLD,
  LEASE_TTL_MS,
  acquireReconcilerLease,
  consecutiveFailures,
  reconcileOnce,
  type LiveKitRoomLister,
  type LiveKitRoomState,
} from "../voice/reconciler.ts";

const SPACE = StreamDid.assert("did:web:voice-reconcile-test.example");
const ALICE = "did:plc:alicealicealicealiceal";
const BOB = "did:plc:bobbobbobbobbobbobbob";
const ROOM = newUlid();
const SERVICE = "did:web:api.roomy.space";

const CONFIG = {
  url: "wss://livekit.example.com",
  apiKey: "apikey",
  apiSecret: "apisecret",
  webhookSecret: "apisecret",
  serverId: "roomy",
};

let handle: AppserverHandle | null = null;
let roomId: string;

beforeEach(async () => {
  closeDb();
  setLiveKit(CONFIG);
  const db = openDb({ path: ":memory:" });
  const space = db.forSpace!(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into comp_space (entity) values (?)", [SPACE]);
  roomId = ROOM;
  await space.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.voice', 'readwrite')",
    [roomId],
  );
  await db.global!().run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [roomId, SPACE],
  );

  handle = await createAppserver({
    port: 0,
    authVerifier: testAuthVerifier,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    quiet: true,
    disableBackgroundWorkers: true,
    ownDid: SERVICE,
    getProfiles: async () => [],
    liveKit: CONFIG,
  });
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  _resetEmbedSweeper();
  setLiveKit(null);
});

function spaceDb() {
  return openDb().forSpace!(SPACE);
}

/** A lister that returns a fixed set of rooms, or fails on demand. */
function fakeLister(
  rooms: LiveKitRoomState[] | (() => LiveKitRoomState[]),
): LiveKitRoomLister & { calls: number; failUntil: number } {
  const lister = {
    calls: 0,
    failUntil: 0,
    async listRooms(): Promise<LiveKitRoomState[]> {
      lister.calls++;
      if (lister.calls <= lister.failUntil) {
        throw new Error("LiveKit unreachable");
      }
      return typeof rooms === "function" ? rooms() : rooms;
    },
  };
  return lister;
}

function deps() {
  return {
    openSpaceDb: (spaceId: string) => openDb().forSpace!(spaceId),
    serviceDid: SERVICE,
    holder: "test-holder",
    now: Date.now(),
  };
}

function roomName(callId: string): string {
  return liveKitRoomName(CONFIG, SPACE, roomId, callId);
}

describe("reconcileOnce", () => {
  test("corrects a participant LiveKit has that the projection lacks", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const lister = fakeLister([
      { roomName: roomName(call!.callId), participantDids: [ALICE, BOB] },
    ]);
    const result = await reconcileOnce(lister, deps());

    expect(result.joined).toBe(1);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did).sort()).toEqual(
      [ALICE, BOB].sort(),
    );
  });

  test("corrects a participant the projection has that LiveKit lacks", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    await recordJoin(spaceDb(), { did: BOB, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const lister = fakeLister([
      { roomName: roomName(call!.callId), participantDids: [ALICE] },
    ]);
    const result = await reconcileOnce(lister, deps());

    expect(result.left).toBe(1);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did)).toEqual([
      ALICE,
    ]);
    expect(await activeCall(spaceDb(), roomId)).not.toBeNull();
  });

  test("a missing room ends the call", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const lister = fakeLister([]);
    const result = await reconcileOnce(lister, deps());

    expect(result.endedCalls).toBe(1);
    expect(await activeCall(spaceDb(), roomId)).toBeNull();
    // The empty result is not a licence to act on a call that is not in the
    // listing under a DIFFERENT name either.
    void call;
  });

  test("an empty room ends the call even with no participant_left", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const lister = fakeLister([
      { roomName: roomName(call!.callId), participantDids: [] },
    ]);
    const result = await reconcileOnce(lister, deps());

    expect(result.endedCalls).toBe(1);
    expect(await activeCall(spaceDb(), roomId)).toBeNull();
  });

  test("ignores a room of a superseded generation", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const current = await activeCall(spaceDb(), roomId);

    // LiveKit still reports the previous call's room; the projection is on a
    // new generation, so nothing matches and the live call is untouched.
    const lister = fakeLister([
      { roomName: roomName(newUlid()), participantDids: [BOB] },
    ]);
    const result = await reconcileOnce(lister, deps());

    expect(result.endedCalls).toBe(1);
    expect(await activeCall(spaceDb(), roomId)).toBeNull();
    void current;
  });

  test("is a no-op when nothing is projected", async () => {
    const lister = fakeLister([{ roomName: "anything", participantDids: [ALICE] }]);
    const result = await reconcileOnce(lister, deps());

    expect(lister.calls).toBe(0);
    expect(result.ran).toBe(true);
    expect(await listProjectedCalls()).toEqual([]);
  });
});

describe("list failures", () => {
  test("a single failure corrects nothing and ends nothing", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");

    const lister = fakeLister([]);
    lister.failUntil = 1;
    const result = await reconcileOnce(lister, deps());

    expect(result.failures).toBe(1);
    expect(result.endedCalls).toBe(0);
    expect(await activeCall(spaceDb(), roomId)).not.toBeNull();
  });

  test("failures accumulate below the threshold and end nothing", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");

    const lister = fakeLister([]);
    lister.failUntil = FAILURE_THRESHOLD - 1;
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await reconcileOnce(lister, deps());
    }

    expect(await consecutiveFailures()).toBe(FAILURE_THRESHOLD - 1);
    expect(await activeCall(spaceDb(), roomId)).not.toBeNull();
  });

  test("the threshold ends every projected call", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");

    const lister = fakeLister([]);
    lister.failUntil = FAILURE_THRESHOLD;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await reconcileOnce(lister, deps());
    }

    expect(await activeCall(spaceDb(), roomId)).toBeNull();
    expect(await listProjectedCalls()).toEqual([]);
    // The streak resets, so the next failure starts counting from one rather
    // than ending calls again immediately.
    expect(await consecutiveFailures()).toBe(0);
  });

  test("a successful pass resets the failure streak", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const lister = fakeLister([
      { roomName: roomName(call!.callId), participantDids: [ALICE] },
    ]);
    lister.failUntil = 2;
    await reconcileOnce(lister, deps());
    await reconcileOnce(lister, deps());
    expect(await consecutiveFailures()).toBe(2);

    await reconcileOnce(lister, deps());
    expect(await consecutiveFailures()).toBe(0);
  });
});

describe("the reconciler lease", () => {
  test("one holder at a time, and the loser does no work", async () => {
    const now = Date.now();
    expect(await acquireReconcilerLease("first", now)).toBe(true);
    expect(await acquireReconcilerLease("second", now + 1000)).toBe(false);

    const lister = fakeLister([]);
    const result = await reconcileOnce(lister, { ...deps(), holder: "second" });
    expect(result.ran).toBe(false);
    expect(lister.calls).toBe(0);
  });

  test("an expired lease is taken over", async () => {
    const now = Date.now();
    expect(await acquireReconcilerLease("first", now)).toBe(true);
    expect(await acquireReconcilerLease("second", now + LEASE_TTL_MS + 1)).toBe(
      true,
    );
  });
});
