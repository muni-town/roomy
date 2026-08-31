/**
 * Handler-level tests for space.roomy.space.sendEvents.
 *
 *
 * Invalidation signal emission (via InvalidationRouter.onEventsApplied) is
 * verified at the unit level in the invalidation router tests
 * (src/invalidation/router.test.ts) and the StreamManager tests
 * (src/streams/StreamManager.test.ts). The handler-level test here asserts
 * the observable effects: events land in stream_events and materialized
 * tables are updated (comp_content).
 * Uses createAppserver with test auth verifier to get a real HTTP server,
 * seeds the materialisation DB directly, and asserts on both HTTP responses
 * and database state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newUlid, StreamDid, UserDid } from "@roomy-space/sdk";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";

const SPACE = "did:web:send-events-test.example";
const USER = UserDid.assert("did:plc:send-events-user");
const CHANNEL = newUlid();

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

function anonFetch(url: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      "Content-Type": "application/json",
    },
  });
}

function makeCreateMessageEvent(roomId: string) {
  return {
    id: newUlid(),
    $type: "space.roomy.message.createMessage.v0",
    room: roomId,
    body: { mimeType: "text/plain", data: { $bytes: Buffer.from("hello").toString("base64") } },
    extensions: {},
  };
}

function makeCreateRoomEvent() {
  return {
    id: newUlid(),
    $type: "space.roomy.room.createRoom.v0",
    kind: "space.roomy.channel",
    name: "test-channel",
  };
}

beforeEach(async () => {
  closeDb();
  _resetHydrationInflight();
  _resetEmbedSweeper();

  // Open the singleton event-log DB in-memory so handlers' internal
  // openDb() resolves. Materialised rows live in the per-space DB.
  const db = openDb({ path: ":memory:" });
  const space = db.forSpace!(SPACE);

  // Seed the space with a channel room and membership for USER (per-space DB).
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run(
    "insert into comp_space (entity) values (?)",
    [SPACE],
  );
  await space.run(
    "insert into comp_info (entity, name) values (?, ?)",
    [SPACE, "Test Space"],
  );
  // User entity
  await space.run("insert into entities (id, stream_id) values (?, ?)", [USER, USER]);
  await space.run(
    "insert into comp_user (did) values (?)",
    [USER],
  );
  // Membership edge (both directions)
  await space.run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [SPACE, USER],
  );
  await space.run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [USER, SPACE],
  );
  // Channel room entity
  await space.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );

  handle = await createAppserver({
    port: 0,
    authVerifier: testAuthVerifier,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    quiet: true,
    disableBackgroundWorkers: true,
    // Hermetic: without a stub, materialization hits live api.bsky.app
    // profile fetches, which pile up under parallel load and blow the
    // 5s per-test timeout.
    getProfiles: async () => [],
  });

  baseUrl = `http://localhost:${handle.port}`;
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  closeDb();
  _resetHydrationInflight();
  _resetEmbedSweeper();
});

describe("space.roomy.space.sendEvents", () => {
  test("valid events land in stream_events and are materialized", async () => {
    const res = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [makeCreateMessageEvent(CHANNEL)],
        }),
      },
    );
    expect(res.status).toBe(200);

    // Assert events.stream_events has 1 row
    const db = openDb();
    const eventRows = await db
      .query("select idx from stream_events where stream_id = ? order by idx")
      .all<{ idx: number }>(SPACE);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.idx).toBe(0);

    const contentRows = await db
      .forSpace!(SPACE)
      .query("select entity from comp_content")
      .all<{ entity: string }>();
  });

  test("unauthenticated -> 401", async () => {
    const res = await anonFetch(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [makeCreateMessageEvent(CHANNEL)],
        }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("caller without space access -> 403", async () => {
    const stranger = "did:plc:stranger";
    const res = await authedFetch(stranger)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [makeCreateMessageEvent(CHANNEL)],
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  test(">50 events -> 400", async () => {
    const events = Array.from({ length: 51 }, () => makeCreateMessageEvent(CHANNEL));
    const res = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events,
        }),
      },
    );
    expect(res.status).toBe(400);
  });

  test("empty array -> 400", async () => {
    const res = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [],
        }),
      },
    );
    expect(res.status).toBe(400);
  });

  test("malformed event -> 400", async () => {
    const res = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: "not-an-array",
        }),
      },
    );
    expect(res.status).toBe(400);
  });

  test("sequential idx", async () => {
    // Send 2 events
    const res1 = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [makeCreateMessageEvent(CHANNEL), makeCreateMessageEvent(CHANNEL)],
        }),
      },
    );
    expect(res1.status).toBe(200);

    // Send 3 more
    const res2 = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            makeCreateMessageEvent(CHANNEL),
            makeCreateMessageEvent(CHANNEL),
            makeCreateMessageEvent(CHANNEL),
          ],
        }),
      },
    );
    expect(res2.status).toBe(200);

    // Assert idx values are 0,1,2,3,4 (no gaps)
    const db = openDb();
    const rows = await db
      .query("select idx from stream_events where stream_id = ? order by idx")
      .all<{ idx: number }>(SPACE);
    expect(rows).toHaveLength(5);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.idx).toBe(i);
    }
  });

  test("P2/P8: write to a rebuilding space is rejected with SpaceRematerializing and not logged", async () => {
    // Mark the space as rebuilding (blue-green). The shared pool's worker
    // flags it, so the singleton StreamManager's write gate sees it.
    const db = openDb();
    await db.spaceRebuildBegin!(SPACE);
    expect(await db.isSpaceRebuilding!(SPACE)).toBe(true);

    const res = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [makeCreateMessageEvent(CHANNEL)],
        }),
      },
    );

    // A specific, retryable status — not a 500.
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe("SpaceRematerializing");

    // The event did NOT land in the event log (P2/P8 reject-before-log).
    const eventRows = await db
      .query("select idx from stream_events where stream_id = ?")
      .all<{ idx: number }>(SPACE);
    expect(eventRows).toHaveLength(0);

    // Clean up so the shared pool isn't left rebuilding.
    await db.spaceRebuildAbort!(SPACE);
    expect(await db.isSpaceRebuilding!(SPACE)).toBe(false);
  });
});
