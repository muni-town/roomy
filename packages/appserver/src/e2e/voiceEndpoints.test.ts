/**
 * The voice RPCs over HTTP: authorization, the unconfigured path, and the
 * token/participant contract the client is written against.
 *
 * These run against a real appserver with the test-auth verifier, so the
 * membership gate, the response shape, and the schema validation are all the
 * ones production exercises.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newUlid, StreamDid, UserDid } from "@roomy-space/sdk";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { setLiveKit, LIVEKIT_TOKEN_TTL_SECONDS } from "../voice/livekit.ts";

const SPACE = StreamDid.assert("did:web:voice-rpc-test.example");
const MEMBER = UserDid.assert("did:plc:membermembermembermem");
const OUTSIDER = UserDid.assert("did:plc:outsideroutsideroutsi");
const ROOM = newUlid();
const VOICE_ROOM = newUlid();

const CONFIG = {
  url: "wss://livekit.example.com",
  apiKey: "apikey",
  apiSecret: "apisecret",
  webhookSecret: "webhooksecret",
  serverId: "roomy",
};

let handle: AppserverHandle | null = null;
let baseUrl: string;
let configured = true;

function authedFetch(did: string) {
  return (url: string, init?: RequestInit) =>
    fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        "X-Test-Did": did,
        "Content-Type": "application/json",
      },
    });
}

async function start(spaceDb: { roomId: string }) {
  closeDb();
  const db = openDb({ path: ":memory:" });
  const space = db.forSpace!(SPACE);

  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into comp_space (entity) values (?)", [SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [MEMBER, MEMBER]);
  await space.run("insert into comp_user (did) values (?)", [MEMBER]);
  await space.run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [SPACE, MEMBER],
  );
  await space.run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [MEMBER, SPACE],
  );

  // A voice room and a plain channel, so the "voice room kind" contract is
  // observable through the metadata endpoint.
  for (const [id, label] of [
    [spaceDb.roomId, "space.roomy.channel"],
    [VOICE_ROOM, "space.roomy.voice"],
  ] as const) {
    await space.run("insert into entities (id, stream_id) values (?, ?)", [id, SPACE]);
    await space.run(
      "insert into comp_room (entity, label, default_access) values (?, ?, 'readwrite')",
      [id, label],
    );
    await space.run(
      "insert into comp_info (entity, name) values (?, ?)",
      [id, label === "space.roomy.voice" ? "Voice" : "general"],
    );
  }

  const global = db.global!();
  for (const id of [spaceDb.roomId, VOICE_ROOM]) {
    await global.run(
      "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
      [id, SPACE],
    );
  }

  setLiveKit(configured ? CONFIG : null);
  handle = await createAppserver({
    port: 0,
    authVerifier: testAuthVerifier,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    quiet: true,
    disableBackgroundWorkers: true,
    ownDid: SPACE,
    getProfiles: async () => [],
    liveKit: configured ? CONFIG : null,
  });
  baseUrl = `http://localhost:${handle.port}`;
}

beforeEach(async () => {
  configured = true;
  await start({ roomId: ROOM });
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  closeDb();
  _resetEmbedSweeper();
  setLiveKit(null);
});

describe("space.roomy.voice.getToken", () => {
  test("mints a token for a member, with the call id, url, key and TTL", async () => {
    const res = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.voice.getToken?roomId=${ROOM}`,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(typeof body.token).toBe("string");
    expect(typeof body.callId).toBe("string");
    expect(body.livekitUrl).toBe(CONFIG.url);
    expect(typeof body.e2eeKey).toBe("string");
    expect(body.ttl).toBe(LIVEKIT_TOKEN_TTL_SECONDS);

    // The token is a JWT whose room grant names this call.
    const claims = JSON.parse(
      Buffer.from((body.token as string).split(".")[1]!, "base64url").toString(),
    ) as { sub: string; video: { room: string } };
    expect(claims.sub).toBe(MEMBER);
    expect(claims.video.room).toContain(body.callId as string);
  });

  test("returns nulls for every field when LiveKit is unconfigured", async () => {
    await handle!.close();
    closeDb();
    configured = false;
    await start({ roomId: ROOM });

    const res = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.voice.getToken?roomId=${ROOM}`,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      token: null,
      callId: null,
      livekitUrl: null,
      e2eeKey: null,
      ttl: null,
    });
  });

  test("403s a non-member", async () => {
    const res = await authedFetch(OUTSIDER)(
      `${baseUrl}/xrpc/space.roomy.voice.getToken?roomId=${ROOM}`,
    );
    expect(res.status).toBe(403);
  });

  test("rejects an anonymous caller", async () => {
    const res = await fetch(
      `${baseUrl}/xrpc/space.roomy.voice.getToken?roomId=${ROOM}`,
    );
    // The membership gate answers first: with no identity there is no
    // membership, and the room-read check reports it as forbidden rather than
    // exposing which of the two failed.
    expect(res.status).toBe(403);
  });

  test("404s an unknown room", async () => {
    const res = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.voice.getToken?roomId=${newUlid()}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("space.roomy.voice.join and leave", () => {
  async function call(nsid: string, did: UserDid, roomId: string) {
    return authedFetch(did)(`${baseUrl}/xrpc/${nsid}`, {
      method: "POST",
      body: JSON.stringify({ roomId }),
    });
  }

  test("join starts a call and exposes the participant", async () => {
    expect((await call("space.roomy.voice.join", MEMBER, ROOM)).status).toBe(200);

    const res = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.voice.getParticipants?roomId=${ROOM}`,
    );
    const body = (await res.json()) as {
      callId: string | null;
      participants: Array<{ did: string; source: string }>;
    };

    expect(body.callId).not.toBeNull();
    expect(body.participants).toHaveLength(1);
    expect(body.participants[0]!.did).toBe(MEMBER);
    expect(body.participants[0]!.source).toBe("user");
  });

  test("leave ends the call when the caller was the last participant", async () => {
    await call("space.roomy.voice.join", MEMBER, ROOM);
    expect((await call("space.roomy.voice.leave", MEMBER, ROOM)).status).toBe(200);

    const res = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.voice.getParticipants?roomId=${ROOM}`,
    );
    expect(await res.json()).toEqual({
      roomId: ROOM,
      callId: null,
      participants: [],
    });
  });

  test("join 403s a non-member", async () => {
    expect((await call("space.roomy.voice.join", OUTSIDER, ROOM)).status).toBe(403);
  });

  test("leave 403s a non-member", async () => {
    expect((await call("space.roomy.voice.leave", OUTSIDER, ROOM)).status).toBe(403);
  });

  test("join 400s without a roomId", async () => {
    const res = await authedFetch(MEMBER)(`${baseUrl}/xrpc/space.roomy.voice.join`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("space.roomy.voice.getActiveCalls", () => {
  test("is empty before any call, then lists the room with a call", async () => {
    const before = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.voice.getActiveCalls?spaceId=${SPACE}`,
    );
    expect(await before.json()).toEqual({ calls: [] });

    await authedFetch(MEMBER)(`${baseUrl}/xrpc/space.roomy.voice.join`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });

    const after = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.voice.getActiveCalls?spaceId=${SPACE}`,
    );
    const body = (await after.json()) as {
      calls: Array<{ roomId: string; participantCount: number }>;
    };
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]!.roomId).toBe(ROOM);
    expect(body.calls[0]!.participantCount).toBe(1);
  });

  test("403s a non-member", async () => {
    const res = await authedFetch(OUTSIDER)(
      `${baseUrl}/xrpc/space.roomy.voice.getActiveCalls?spaceId=${SPACE}`,
    );
    expect(res.status).toBe(403);
  });
});

describe("the voice room kind", () => {
  test("a space.roomy.voice room reports kind 'voice'", async () => {
    const res = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${VOICE_ROOM}`,
    );
    const body = (await res.json()) as { kind: string };
    expect(res.status).toBe(200);
    expect(body.kind).toBe("voice");
  });

  test("the sidebar returns the voice room in its own list", async () => {
    const res = await authedFetch(MEMBER)(
      `${baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${SPACE}`,
    );
    const body = (await res.json()) as {
      voiceRooms: Array<{ id: string; canRead: boolean }>;
      sidebar: { orphans: Array<{ id: string }> };
    };

    expect(res.status).toBe(200);
    expect(body.voiceRooms.map((r) => r.id)).toEqual([VOICE_ROOM]);
    // Not an orphan channel: the client places it from `voiceRooms`.
    expect(body.sidebar.orphans.map((r) => r.id)).not.toContain(VOICE_ROOM);
  });
});
