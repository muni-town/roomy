/**
 * Test-mode webhook endpoints.
 *
 * These bypass the HMAC step so a test can drive the pipeline without minting a
 * signed request, and they exist only while `APPSERVER_TEST_MODE=true` — the
 * route is registered inside that branch, so a production process has no code
 * path to reach them.
 *
 * The flag is read at request time (unlike the auth verifier, which is selected
 * when the appserver is built), so this file can flip it around the one request
 * that needs it and assert the absent case with the same server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newUlid, StreamDid } from "@roomy-space/sdk";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { setLiveKit } from "../voice/livekit.ts";
import { liveKitRoomName } from "../voice/tokens.ts";
import { activeCall, listParticipants } from "../voice/projection.ts";
import { recordJoin } from "../voice/callFacts.ts";

const SPACE = StreamDid.assert("did:web:voice-testhook.example");
const ALICE = "did:plc:alicealicealicealiceal";
const BOB = "did:plc:bobbobbobbobbobbobbob";
const ROOM = newUlid();

const CONFIG = {
  url: "wss://livekit.example.com",
  apiKey: "apikey",
  apiSecret: "apisecret",
  webhookSecret: "webhooksecret",
  serverId: "roomy",
};

let handle: AppserverHandle | null = null;
let roomId: string;

beforeEach(async () => {
  closeDb();
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

  // Both identities are space members: a webhook only records facts for a
  // member, so without this the pipeline correctly ignores every event.
  for (const did of [ALICE, BOB]) {
    await space.run("insert into entities (id, stream_id) values (?, ?)", [did, did]);
    await space.run(
      "insert into edges (head, tail, label) values (?, ?, 'member')",
      [SPACE, did],
    );
  }
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
    ownDid: SPACE,
    getProfiles: async () => [],
    liveKit: CONFIG,
  });
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  closeDb();
  _resetEmbedSweeper();
  setLiveKit(null);
  delete process.env.APPSERVER_TEST_MODE;
});

function spaceDb() {
  return openDb().forSpace!(SPACE);
}

function roomName(callId: string): string {
  return liveKitRoomName(CONFIG, SPACE, roomId, callId);
}

async function post(route: string, payload: unknown) {
  return fetch(`http://localhost:${handle!.port}/webhooks/test/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("test webhook endpoints", () => {
  test("are absent unless APPSERVER_TEST_MODE is on", async () => {
    expect(process.env.APPSERVER_TEST_MODE).not.toBe("true");
    const res = await post("call-join", {
      room: { name: roomName(newUllId()) },
      participant: { identity: ALICE },
    });
    expect(res.status).toBe(404);
  });

  test("drive the same handlers the real webhook does", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    process.env.APPSERVER_TEST_MODE = "true";

    const join = await post("call-join", {
      room: { name: roomName(call!.callId) },
      participant: { identity: BOB },
    });
    expect(join.status).toBe(200);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did).sort()).toEqual(
      [ALICE, BOB].sort(),
    );

    const leave = await post("call-leave", {
      room: { name: roomName(call!.callId) },
      participant: { identity: BOB },
    });
    expect(leave.status).toBe(200);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did)).toEqual([
      ALICE,
    ]);

    const finished = await post("call-room-finished", {
      room: { name: roomName(call!.callId) },
    });
    expect(finished.status).toBe(200);
    expect(await activeCall(spaceDb(), roomId)).toBeNull();
  });


  test("400 a malformed body", async () => {
    process.env.APPSERVER_TEST_MODE = "true";
    const res = await fetch(
      `http://localhost:${handle!.port}/webhooks/test/call-join`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      },
    );
    expect(res.status).toBe(400);
  });
});

/** Local alias so the absent-route test reads as naming an unrelated call. */
function newUllId(): string {
  return newUlid();
}
