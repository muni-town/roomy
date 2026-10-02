/**
 * Call facts: the collapse rules, the lifecycle, and the stale-generation
 * guard.
 *
 * Facts are written through `StreamManager.sendEvents`, so the tests drive the
 * real pipeline (event log → materialiser → projection) against the appserver's
 * own worker-backed DBs, then assert on the projection the RPCs read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newUlid, StreamDid } from "@roomy-space/sdk";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import {
  activeCall,
  listParticipants,
  listProjectedCalls,
  participantsIn,
} from "../voice/projection.ts";
import {
  ensureCall,
  recordCallEnded,
  recordJoin,
  recordLeave,
} from "../voice/callFacts.ts";

const SPACE = StreamDid.assert("did:web:voice-facts-test.example");
const ALICE = "did:plc:alicealicealicealiceal";
const BOB = "did:plc:bobbobbobbobbobbobbob";
const ROOM = newUlid();
const CHANNEL = newUlid();

let handle: AppserverHandle | null = null;
let roomId: string;

beforeEach(async () => {
  closeDb();
  const db = openDb({ path: ":memory:" });
  const space = db.forSpace!(SPACE);

  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into comp_space (entity) values (?)", [SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );

  // The voice room the call facts target.
  roomId = ROOM;
  await space.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.voice', 'readwrite')",
    [roomId],
  );

  const global = db.global!();
  await global.run(
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
    ownDid: SPACE,
    getProfiles: async () => [],
  });
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  closeDb();
  _resetEmbedSweeper();
});

/** The per-space DB handle the projection reads go through. */
function spaceDb() {
  return openDb().forSpace!(SPACE);
}

function actor(did: string, callId?: string) {
  return {
    did,
    spaceId: SPACE,
    roomId,
    ...(callId ? { callId } : {}),
  } as const;
}

describe("call lifecycle", () => {
  test("ensureCall starts a call and is idempotent", async () => {
    const first = await ensureCall(spaceDb(), actor(ALICE), "user");
    const second = await ensureCall(spaceDb(), actor(BOB), "user");

    expect(second).toBe(first);
    const call = await activeCall(spaceDb(), roomId);
    expect(call?.callId).toBe(first);
    expect(call?.source).toBe("user");
  });

  test("joining an empty room starts the call and records the participant", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");

    const call = await activeCall(spaceDb(), roomId);
    expect(call).not.toBeNull();
    const participants = await listParticipants(spaceDb(), roomId);
    expect(participants.map((p) => p.did)).toEqual([ALICE]);
    expect(participants[0]!.callId).toBe(call!.callId);
  });

  test("the last participant leaving ends the call", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    await recordLeave(spaceDb(), actor(ALICE), "user");

    expect(await activeCall(spaceDb(), roomId)).toBeNull();
    expect(await listParticipants(spaceDb(), roomId)).toEqual([]);
  });

  test("a departure with others remaining keeps the call alive", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    await recordJoin(spaceDb(), actor(BOB), "user");
    await recordLeave(spaceDb(), actor(ALICE), "user");

    const call = await activeCall(spaceDb(), roomId);
    expect(call).not.toBeNull();
    expect([...(await participantsIn(spaceDb(), roomId, call!.callId))]).toEqual([
      BOB,
    ]);
  });
});

describe("fact idempotency", () => {
  test("a repeated join does not duplicate the participant", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    // The LiveKit webhook confirming what the client already recorded.
    await recordJoin(spaceDb(), actor(ALICE), "livekit");

    const participants = await listParticipants(spaceDb(), roomId);
    expect(participants).toHaveLength(1);
    // The first writer's source survives: a confirmation is not a rewrite.
    expect(participants[0]!.source).toBe("user");
  });

  test("a leave for someone not in the call is a no-op", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    const before = await activeCall(spaceDb(), roomId);

    await recordLeave(spaceDb(), actor(BOB), "livekit");

    expect((await activeCall(spaceDb(), roomId))?.callId).toBe(before!.callId);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did)).toEqual([
      ALICE,
    ]);
  });

  test("ending an already-ended call is a no-op", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    const call = await activeCall(spaceDb(), roomId);
    await recordLeave(spaceDb(), actor(ALICE), "user");

    // A stale retry, after the call is gone.
    await recordCallEnded(
      spaceDb(),
      { ...actor(ALICE), callId: call!.callId },
      "reconciliation",
    );
    expect(await activeCall(spaceDb(), roomId)).toBeNull();
  });

  test("a stale callId neither joins nor ends the current call", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    const current = await activeCall(spaceDb(), roomId);

    // A previous generation, superseded before this webhook arrived.
    const stale = newUlid();
    await recordJoin(spaceDb(), actor(BOB, stale), "livekit");
    await recordCallEnded(
      spaceDb(),
      { ...actor(ALICE), callId: stale },
      "reconciliation",
    );

    expect((await activeCall(spaceDb(), roomId))?.callId).toBe(current!.callId);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did)).toEqual([
      ALICE,
    ]);
  });
});

describe("cross-space index", () => {
  test("a started call is readable from the global projected-calls table", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");

    const projected = await listProjectedCalls();
    expect(projected).toHaveLength(1);
    expect(projected[0]!.roomId).toBe(roomId);
    expect(projected[0]!.spaceId).toBe(SPACE);
  });

  test("ending the call removes it from the index", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    await recordLeave(spaceDb(), actor(ALICE), "user");

    expect(await listProjectedCalls()).toEqual([]);
  });
});

describe("a superseding call generation", () => {
  test("does not inherit the previous generation's participants", async () => {
    await recordJoin(spaceDb(), actor(ALICE), "user");
    await recordJoin(spaceDb(), actor(BOB), "user");

    const first = await activeCall(spaceDb(), roomId);
    await recordCallEnded(
      spaceDb(),
      { ...actor(ALICE), callId: first!.callId },
      "reconciliation",
    );
    await recordJoin(spaceDb(), actor(ALICE), "user");

    const second = await activeCall(spaceDb(), roomId);
    expect(second!.callId).not.toBe(first!.callId);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did)).toEqual([
      ALICE,
    ]);
  });
});
