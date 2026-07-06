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

  // Use a unique events DB path per test so events don't leak between tests.
  const testId = Math.random().toString(36).slice(2, 8);
  process.env.EVENTS_DB_PATH = `/tmp/roomy-events-${testId}.sqlite`;

  // Open the singleton DB in-memory so handlers' internal openDb() resolves.
  const db = openDb({ path: ":memory:" });

  // Seed the space with a channel room and membership for USER.
  await db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await db.run(
    "insert into comp_space (entity) values (?)",
    [SPACE],
  );
  await db.run(
    "insert into comp_info (entity, name) values (?, ?)",
    [SPACE, "Test Space"],
  );
  // User entity
  await db.run("insert into entities (id, stream_id) values (?, ?)", [USER, USER]);
  await db.run(
    "insert into comp_user (did) values (?)",
    [USER],
  );
  // Membership edge (both directions)
  await db.run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [SPACE, USER],
  );
  await db.run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [USER, SPACE],
  );
  // Channel room entity
  await db.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );

  handle = await createAppserver({
    port: 0,
    authVerifier: testAuthVerifier,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    quiet: true,
    disableEmbedSweeper: true,
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
  delete process.env.EVENTS_DB_PATH;
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
      .query<{ idx: number }>(
        "select idx from events.stream_events where stream_id = ? order by idx",
      )
      .all(SPACE);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.idx).toBe(0);

    // Assert materialized comp_content has a row for the message
    const contentRows = await db
      .query<{ entity: string }>(
        "select entity from comp_content",
      )
      .all();
    expect(contentRows.length).toBeGreaterThanOrEqual(1);
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
      .query<{ idx: number }>(
        "select idx from events.stream_events where stream_id = ? order by idx",
      )
      .all(SPACE);
    expect(rows).toHaveLength(5);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.idx).toBe(i);
    }
  });
});
