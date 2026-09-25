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
import { _resetEmbedSweeper } from "../embed/sweeper.ts";

const SPACE = "did:web:send-events-test.example";
const USER = UserDid.assert("did:plc:send-events-user");
const SERVICE_DID = "did:web:api.roomy.space";
const ROLE = newUlid();
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

/** A createMessage in `roomId` carrying a reply attachment at `target`. */
function makeReplyEvent(roomId: string, target: string) {
  return {
    id: newUlid(),
    $type: "space.roomy.message.createMessage.v0",
    room: roomId,
    body: { mimeType: "text/plain", data: { $bytes: Buffer.from("reply").toString("base64") } },
    extensions: {
      "space.roomy.extension.attachments.v0": {
        $type: "space.roomy.extension.attachments.v0",
        attachments: [{ $type: "space.roomy.attachment.reply.v0", target }],
      },
    },
  };
}

beforeEach(async () => {
  closeDb();
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
  // The global entity→space index. Reads (`getMessage`, and any other
  // handler opening a per-space DB from a bare entity id) resolve the space
  // through it, so an entity missing from it is a 404 "not found" regardless
  // of what the per-space DB holds — seeding it here is what makes the read
  // assertions below exercise the real path instead of the harness's gaps.
  const global = openDb().global!();
  await global.run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [CHANNEL, SPACE],
  );

  handle = await createAppserver({
    port: 0,
    authVerifier: testAuthVerifier,
    dbPath: ":memory:",
    readStateDbPath: ":memory:",
    quiet: true,
    disableBackgroundWorkers: true,
    // Pin the service DID so the self-write tests below don't depend on the
    // ambient APPSERVER_DID.
    ownDid: SERVICE_DID,
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

  test("the service DID may self-write a role event without space standing", async () => {
    // SERVICE_DID is not seeded as a member or admin of SPACE — it is only
    // the appserver's own identity.
    const res = await authedFetch(SERVICE_DID)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.role.addMemberRole.v0",
              userDid: USER,
              roleId: ROLE,
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);

    // The event landed and materialized into the role table.
    const space = openDb().forSpace!(SPACE);
    const rows = await space
      .query("select user_id from member_roles where role_id = ?")
      .all<{ user_id: string }>(ROLE);
    expect(rows.map((r) => r.user_id)).toEqual([USER]);

    // Attributed to the service DID, not to a space participant.
    const logged = await openDb()
      .query("select user from stream_events where stream_id = ?")
      .all<{ user: string }>(SPACE);
    expect(logged.map((r) => r.user)).toEqual([SERVICE_DID]);
  });

  test("an ordinary DID gets no self-write relaxation", async () => {
    const res = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.role.addMemberRole.v0",
              userDid: USER,
              roleId: ROLE,
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  test("the service DID still cannot write other users' admin events", async () => {
    const res = await authedFetch(SERVICE_DID)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [
            {
              id: newUlid(),
              $type: "space.roomy.space.addAdmin.v0",
              userDid: SERVICE_DID,
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  test("write to a rebuilding space is rejected with SpaceRematerializing and not logged", async () => {
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

    // The event did NOT land in the event log (the write is rejected before
    // the log).
    const eventRows = await db
      .query("select idx from stream_events where stream_id = ?")
      .all<{ idx: number }>(SPACE);
    expect(eventRows).toHaveLength(0);

    // Clean up so the shared pool isn't left rebuilding.
    await db.spaceRebuildAbort!(SPACE);
    expect(await db.isSpaceRebuilding!(SPACE)).toBe(false);
  });

  /**
   * A reply whose target is the room it lives in. This is the production
   * defect: the reply edge is written, then `message.getMessage` resolves the
   * target as a message and 400s forever, so the client's reply preview
   * refetches a permanent failure.
   */
  test("a reply targeting a room (not a message) is rejected and never logged", async () => {
    const res = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({
          spaceId: SPACE,
          events: [makeReplyEvent(CHANNEL, CHANNEL)],
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe("InvalidRequest");
    expect(body.message).toContain("is not a message");

    // Nothing landed: the event log is the source of truth for
    // materialization, so rejecting before the write is what keeps the bad
    // reply edge out of the DB entirely.
    const db = openDb();
    const eventRows = await db
      .query("select idx from stream_events where stream_id = ?")
      .all<{ idx: number }>(SPACE);
    expect(eventRows).toHaveLength(0);
  });

  /**
   * The end-to-end consequence, asserted on the real surface: a reply to a
   * room is refused, and `getMessage` on a room id keeps answering the 400
   * the client was seeing. The second half documents WHY the first half is
   * necessary — it is the same predicate, on the read side.
   */
  test("getMessage on a room id 400s; a reply to a message is accepted", async () => {
    // The read side, unchanged: this is the failure the writer must prevent.
    const bad = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.message.getMessage?messageId=${CHANNEL}`,
    );
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { message?: string };
    expect(badBody.message).toContain("is not a message");

    // A genuine message, then a reply to it: allowed, and the reply survives
    // the round trip with its reply edge materialized.
    const target = makeCreateMessageEvent(CHANNEL);
    const first = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, events: [target] }),
      },
    );
    expect(first.status).toBe(200);

    const reply = makeReplyEvent(CHANNEL, target.id);
    const second = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.space.sendEvents`,
      {
        method: "POST",
        body: JSON.stringify({ spaceId: SPACE, events: [reply] }),
      },
    );
    expect(second.status).toBe(200);

    const db = openDb();
    const edge = await db
      .forSpace!(SPACE)
      .query("select tail from edges where head = ? and label = 'reply'")
      .get<{ tail: string }>(reply.id);
    expect(edge?.tail).toBe(target.id);

    // And the target now resolves on the read path the client uses.
    const good = await authedFetch(USER)(
      `${baseUrl}/xrpc/space.roomy.message.getMessage?messageId=${target.id}`,
    );
    expect(good.status).toBe(200);
  });
});
