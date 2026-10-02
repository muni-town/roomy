/**
 * The LiveKit webhook: signature validation, room routing, and the transition
 * it records.
 *
 * Requests are minted the way LiveKit mints them, so the HMAC path is exercised
 * for real rather than bypassed — a signature check that is never run in a test
 * is a signature check nobody knows works.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { newUlid, StreamDid } from "@roomy-space/sdk";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { setLiveKit } from "../voice/livekit.ts";
import { liveKitRoomName } from "../voice/tokens.ts";
import { activeCall, listParticipants } from "../voice/projection.ts";
import { recordJoin } from "../voice/callFacts.ts";
import { processLiveKitWebhook } from "../voice/webhook.ts";

const SPACE = StreamDid.assert("did:web:voice-webhook-test.example");
const ALICE = "did:plc:alicealicealicealiceal";
const BOB = "did:plc:bobbobbobbobbobbobbob";
const ROOM = newUlid();

const CONFIG = {
  url: "wss://livekit.example.com",
  apiKey: "apikey",
  apiSecret: "apisecret",
  webhookSecret: "webhook-secret",
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
});

function spaceDb() {
  return openDb().forSpace!(SPACE);
}

function roomName(callId: string): string {
  return liveKitRoomName(CONFIG, SPACE, roomId, callId);
}

/** Sign a body the way LiveKit signs one. */
function sign(body: Buffer, secret = CONFIG.webhookSecret): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 60,
      sha256: createHash("sha256").update(body).digest("base64url"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${claims}`)
    .digest("base64url");
  return `Bearer ${header}.${claims}.${signature}`;
}

function request(payload: unknown, secret = CONFIG.webhookSecret) {
  const body = Buffer.from(JSON.stringify(payload));
  return { authorization: sign(body, secret), body };
}

describe("HMAC validation", () => {
  test("rejects a bad signature before parsing the body", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const outcome = await processLiveKitWebhook(
      request(
        {
          event: "room_finished",
          room: { name: roomName(call!.callId) },
        },
        "wrong-secret",
      ),
    );

    expect(outcome.status).toBe(401);
    // The forged end must not have landed.
    expect(await activeCall(spaceDb(), roomId)).not.toBeNull();
  });

  test("rejects an unsigned request", async () => {
    const outcome = await processLiveKitWebhook({
      authorization: null,
      body: Buffer.from(JSON.stringify({ event: "room_finished" })),
    });
    expect(outcome.status).toBe(401);
  });

  test("rejects a body modified after signing", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const signed = request({ event: "participant_joined", room: { name: roomName(call!.callId) } });
    const tampered = Buffer.from(
      JSON.stringify({
        event: "room_finished",
        room: { name: roomName(call!.callId) },
      }),
    );
    const outcome = await processLiveKitWebhook({
      authorization: signed.authorization,
      body: tampered,
    });

    expect(outcome.status).toBe(401);
    expect(await activeCall(spaceDb(), roomId)).not.toBeNull();
  });

  test("accepts a correctly signed request", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    const outcome = await processLiveKitWebhook(
      request({
        event: "participant_joined",
        room: { name: roomName(call!.callId) },
        participant: { identity: BOB },
      }),
    );

    expect(outcome.status).toBe(200);
    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did).sort()).toEqual(
      [ALICE, BOB].sort(),
    );
  });
});

describe("room-name routing", () => {
  test("ignores another deployment's rooms on a shared LiveKit project", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");

    const foreign = `other.${SPACE}.${roomId}@${newUlid()}`;
    const outcome = await processLiveKitWebhook(
      request({
        event: "room_finished",
        room: { name: foreign },
      }),
    );

    expect(outcome.status).toBe(200);
    expect(await activeCall(spaceDb(), roomId)).not.toBeNull();
  });

  test("ignores a payload with no room name", async () => {
    const outcome = await processLiveKitWebhook(
      request({ event: "participant_joined", participant: { identity: ALICE } }),
    );
    expect(outcome.status).toBe(200);
  });
});

describe("participant transitions", () => {
  test("participant_joined records the LIVEKIT-sourced fact", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    await processLiveKitWebhook(
      request({
        event: "participant_joined",
        room: { name: roomName(call!.callId) },
        participant: { identity: BOB },
      }),
    );

    const participants = await listParticipants(spaceDb(), roomId);
    expect(participants.find((p) => p.did === BOB)?.source).toBe("livekit");
  });

  test("participant_left removes the participant", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    await recordJoin(spaceDb(), { did: BOB, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    await processLiveKitWebhook(
      request({
        event: "participant_left",
        room: { name: roomName(call!.callId) },
        participant: { identity: BOB },
      }),
    );

    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did)).toEqual([
      ALICE,
    ]);
  });

  test("room_finished ends the call", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    await processLiveKitWebhook(
      request({
        event: "room_finished",
        room: { name: roomName(call!.callId) },
      }),
    );

    expect(await activeCall(spaceDb(), roomId)).toBeNull();
  });

  test("a webhook for a superseded generation is ignored", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const current = await activeCall(spaceDb(), roomId);

    await processLiveKitWebhook(
      request({
        event: "room_finished",
        room: { name: roomName(newUlid()) },
      }),
    );

    expect((await activeCall(spaceDb(), roomId))?.callId).toBe(current!.callId);
  });

  test("a companion publisher is not a participant", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const call = await activeCall(spaceDb(), roomId);

    await processLiveKitWebhook(

      request({
        event: "participant_joined",
        room: { name: roomName(call!.callId) },
        participant: { identity: "companion:macbook-screencapture" },
      }),
    );

    expect((await listParticipants(spaceDb(), roomId)).map((p) => p.did)).toEqual([
      ALICE,
    ]);
  });

  test("a track event is not a call-state transition", async () => {
    await recordJoin(spaceDb(), { did: ALICE, spaceId: SPACE, roomId }, "user");
    const before = await activeCall(spaceDb(), roomId);

    await processLiveKitWebhook(
      request({
        event: "track_published",
        room: { name: roomName(before!.callId) },
        participant: { identity: ALICE },
      }),
    );

    expect((await activeCall(spaceDb(), roomId))?.callId).toBe(before!.callId);
  });
});
