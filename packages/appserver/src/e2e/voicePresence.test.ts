/**
 * Voice presence end to end, with two connected clients.
 *
 * This is the observable contract the client is written against: the RPCs
 * produce call facts, the facts materialise, and the resulting presence reaches
 * the other participant over the sync socket — over a real HTTP server and a
 * real WebSocket, with no LiveKit in reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newUlid, sync, StreamDid, UserDid } from "@roomy-space/sdk";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";

const SPACE = StreamDid.assert("did:web:voice-e2e.example");
const ALICE = UserDid.assert("did:plc:alicealicealicealiceal");
const BOB = UserDid.assert("did:plc:bobbobbobbobbobbobbob");
const ROOM = newUlid();

interface DecodedFrame {
  header: Record<string, unknown>;
  body: Record<string, unknown>;
}

let handle: AppserverHandle | null = null;
let baseUrl: string;

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

beforeEach(async () => {
  closeDb();
  const db = openDb({ path: ":memory:" });
  const space = db.forSpace!(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  // Invite-only: membership is then the only way to read a room, which is what
  // makes the outsider case below assert something.
  await space.run(
    "insert into comp_space (entity, allow_public_join) values (?, 0)",
    [SPACE],
  );
  for (const did of [ALICE, BOB]) {
    await space.run("insert into entities (id, stream_id) values (?, ?)", [did, did]);
    await space.run(
      "insert into edges (head, tail, label) values (?, ?, 'member')",
      [SPACE, did],
    );
  }
  await space.run("insert into entities (id, stream_id) values (?, ?)", [ROOM, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.voice', 'readwrite')",
    [ROOM],
  );
  await db.global!().run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [ROOM, SPACE],
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
    // Configured, but unreachable: nothing here mints a token or lists rooms,
    // so presence must work without an SFU in reach.
    liveKit: {
      url: "wss://livekit.invalid",
      apiKey: "apikey",
      apiSecret: "apisecret",
      webhookSecret: "apisecret",
      serverId: "roomy",
    },
  });
  baseUrl = `http://localhost:${handle.port}`;
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  closeDb();
  _resetEmbedSweeper();
});

async function openWs(did: UserDid): Promise<WebSocket> {
  const ticketRes = await authedFetch(did)(
    `${baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
    { method: "POST", body: "{}" },
  );
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const ws = new WebSocket(
    `${baseUrl.replace("http", "ws")}/xrpc/space.roomy.sync.subscribe?ticket=${ticket}`,
  );
  ws.binaryType = "arraybuffer";
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("WebSocket connection failed"));
  await promise;
  return ws;
}

/**
 * Frame sink with event-driven waiting: `waitFor` resolves the moment a
 * matching frame arrives, so a run costs no fixed latency and a failure names
 * the frame it wanted.
 */
function frameSink(ws: WebSocket) {
  const frames: DecodedFrame[] = [];
  const waiters = new Set<{ matches: () => boolean; resolve: () => void }>();

  const settled = () => {
    for (const waiter of [...waiters]) {
      if (waiter.matches()) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") return;
    frames.push(sync.decodeCborFrame(ev.data as ArrayBuffer) as DecodedFrame);
    settled();
  };

  return {
    frames,
    waitFor(predicate: (frames: DecodedFrame[]) => boolean): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.add({ matches: () => predicate(frames), resolve });
      settled();
      return promise;
    },
  };
}

function ofType(frames: DecodedFrame[], t: string): DecodedFrame[] {
  return frames.filter((f) => f.header["t"] === t);
}

describe("voice presence end to end", () => {
  test("a join reaches the other participant as a #voicePresenceDiff", async () => {
    const ws = await openWs(BOB);
    const sink = frameSink(ws);
    ws.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));

    // The subscription is registered after an async access check; the room's
    // eager invalidation is the proof that it took effect.
    await sink.waitFor((frames) => ofType(frames, "#invalidate").length > 0);
    sink.frames.length = 0;

    const res = await authedFetch(ALICE)(`${baseUrl}/xrpc/space.roomy.voice.join`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });
    expect(res.status).toBe(200);

    await sink.waitFor((frames) => ofType(frames, "#voicePresenceDiff").length > 0);
    const presence = ofType(sink.frames, "#voicePresenceDiff")[0]!;
    expect(presence.body["op"]).toBe("join");
    expect(presence.body["did"]).toBe(ALICE);
    const announcedCallId = String(presence.body["callId"]);
    expect(typeof presence.body["callId"]).toBe("string");
    // The participant list agrees with the frame the other client received: a
    // client that reconnects and refetches sees the same call generation.
    const participantsRes = await authedFetch(BOB)(
      `${baseUrl}/xrpc/space.roomy.voice.getParticipants?roomId=${ROOM}`,
    );
    const participants = (await participantsRes.json()) as {
      callId: string;
      participants: Array<{ did: string }>;
    };
    expect(participants.callId).toBe(announcedCallId);
    expect(participants.participants.map((p) => p.did)).toEqual([ALICE]);

    // The sidebar's active-call list carries the same call.
    const activeRes = await authedFetch(BOB)(
      `${baseUrl}/xrpc/space.roomy.voice.getActiveCalls?spaceId=${SPACE}`,
    );
    const active = (await activeRes.json()) as {
      calls: Array<{ roomId: string; callId: string; participantCount: number }>;
    };
    expect(active.calls).toHaveLength(1);
    expect(active.calls[0]!.roomId).toBe(ROOM);
    expect(active.calls[0]!.callId).toBe(announcedCallId);
    expect(active.calls[0]!.participantCount).toBe(1);

    ws.close();
  });

  test("the last participant leaving ends the call for the other client", async () => {
    // ALICE joins first, BOB second, so ALICE's leave is not the last one.
    await authedFetch(ALICE)(`${baseUrl}/xrpc/space.roomy.voice.join`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });

    const ws = await openWs(ALICE);
    const sink = frameSink(ws);
    ws.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));
    await sink.waitFor((frames) => ofType(frames, "#invalidate").length > 0);
    sink.frames.length = 0;

    await authedFetch(BOB)(`${baseUrl}/xrpc/space.roomy.voice.join`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });
    await sink.waitFor((frames) =>
      ofType(frames, "#voicePresenceDiff").some((f) => f.body["did"] === BOB),
    );

    await authedFetch(BOB)(`${baseUrl}/xrpc/space.roomy.voice.leave`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });
    await sink.waitFor((frames) =>
      ofType(frames, "#voicePresenceDiff").some((f) => f.body["op"] === "leave"),
    );

    // BOB leaving first must not end the call.
    const stillActive = await authedFetch(ALICE)(
      `${baseUrl}/xrpc/space.roomy.voice.getParticipants?roomId=${ROOM}`,
    );
    const mid = (await stillActive.json()) as { callId: string | null };
    expect(mid.callId).not.toBeNull();

    sink.frames.length = 0;
    await authedFetch(ALICE)(`${baseUrl}/xrpc/space.roomy.voice.leave`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });

    // The final leave ends the call, so the other client is told the call is
    // over rather than one row short.
    await sink.waitFor((frames) =>
      ofType(frames, "#voicePresenceDiff").some((f) => f.body["op"] === "callEnded"),
    );

    const ended = await authedFetch(ALICE)(
      `${baseUrl}/xrpc/space.roomy.voice.getParticipants?roomId=${ROOM}`,
    );
    expect(await ended.json()).toEqual({
      roomId: ROOM,
      callId: null,
      participants: [],
    });

    ws.close();
  });

  test("a voice_state message reaches the room's subscribers", async () => {
    await authedFetch(ALICE)(`${baseUrl}/xrpc/space.roomy.voice.join`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });

    const ws = await openWs(BOB);
    const sink = frameSink(ws);
    ws.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));
    await sink.waitFor((frames) => ofType(frames, "#invalidate").length > 0);
    sink.frames.length = 0;

    // The speaker needs a connection of its own to send on.
    const speaker = await openWs(ALICE);
    const speakerSink = frameSink(speaker);
    speaker.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));
    await speakerSink.waitFor((frames) => ofType(frames, "#invalidate").length > 0);
    speakerSink.frames.length = 0;
    sink.frames.length = 0;

    speaker.send(
      JSON.stringify({
        type: "voice_state",
        roomId: ROOM,
        muted: true,
        deafened: false,
      }),
    );

    await sink.waitFor((frames) => ofType(frames, "#voiceStateDiff").length > 0);
    const state = ofType(sink.frames, "#voiceStateDiff")[0]!;
    expect(state.body).toEqual({
      roomId: ROOM,
      did: ALICE,
      muted: true,
      deafened: false,
    });

    ws.close();
    speaker.close();
  });

  test("a non-member receives no presence for the room", async () => {
    const outsider = UserDid.assert("did:plc:outsideroutsideroutsi");
    await openDb()
      .forSpace!(SPACE)
      .run("insert into entities (id, stream_id) values (?, ?)", [outsider, outsider]);

    const ws = await openWs(outsider);
    const sink = frameSink(ws);
    // The sub is denied (no membership), so no topic and no frames.
    ws.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));

    await authedFetch(ALICE)(`${baseUrl}/xrpc/space.roomy.voice.join`, {
      method: "POST",
      body: JSON.stringify({ roomId: ROOM }),
    });

    // Nothing to wait on — assert the absence after the join has landed and
    // been delivered to the members' connections.
    const memberWs = await openWs(BOB);
    const memberSink = frameSink(memberWs);
    memberWs.send(JSON.stringify({ type: "sub", topic: "room", id: ROOM }));
    await memberSink.waitFor((frames) => ofType(frames, "#invalidate").length > 0);

    expect(ofType(sink.frames, "#voicePresenceDiff")).toEqual([]);

    ws.close();
    memberWs.close();
  });
});
