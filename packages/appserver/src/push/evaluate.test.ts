import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { attachInMemoryReadState } from "../db/readStateDb.ts";
import { evaluatePush } from "./evaluate.ts";
import { setUserDefault } from "../queries/pushPreferences.ts";
import { upsertSubscription } from "../queries/pushSubscriptions.ts";

/**
 * Tests for the Phase 1 push evaluator (Busy immediate pushes only).
 *
 * These mirror the seeding style of `auth/access.test.ts`: a fresh isolated
 * in-memory materialisation DB plus an attached in-memory read-state DB
 * (`readstate.*`) for the push tables. The evaluator reads from both.
 */

const SPACE = "did:web:space.example";
const AUTHOR = "did:plc:alice";
const BUSY_READER = "did:plc:bob";
const ENGAGED_READER = "did:plc:carol";
const BANNED_BUSY = "did:plc:dan";
const CHANNEL = "01CHANNEL00000000000000000";
const MESSAGE_ID = "01MSGBUSYTEST0000000000AA";

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

function seedSpace(db: Database, spaceId = SPACE): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  db.run("insert into comp_space (entity) values (?)", [spaceId]);
}

function seedUser(db: Database, did: string, handle?: string): void {
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  db.run("insert or ignore into comp_user (did, handle) values (?, ?)", [
    did,
    handle ?? null,
  ]);
}

function seedChannel(
  db: Database,
  channelId: string,
  spaceId: string,
  name: string | null,
): void {
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    channelId,
    spaceId,
  ]);
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [channelId],
  );
  if (name !== null) {
    db.run("insert into comp_info (entity, name) values (?, ?)", [
      channelId,
      name,
    ]);
  }
}

function addMember(db: Database, spaceId: string, did: string): void {
  db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
    spaceId,
    did,
  ]);
}

function addBan(db: Database, spaceId: string, did: string): void {
  db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
    spaceId,
    did,
  ]);
}

function addSubscription(db: Database, userDid: string): void {
  upsertSubscription(db, {
    userDid,
    endpoint: `https://push.test/${userDid}`,
    p256dh: "p256dh-key",
    auth: "auth-key",
    expirationTime: null,
  });
}

/** Seed a space with one channel, three members (author, busy, engaged) + a banned busy user. */
function seedFixture(db: Database): void {
  seedSpace(db);
  for (const did of [AUTHOR, BUSY_READER, ENGAGED_READER, BANNED_BUSY]) {
    seedUser(db, did);
  }
  seedUser(db, AUTHOR, "alice.test");
  seedChannel(db, CHANNEL, SPACE, "general");
  // Author display name (comp_info name wins over handle).
  db.run("insert into comp_info (entity, name) values (?, ?)", [
    AUTHOR,
    "Alice",
  ]);
  // Membership.
  for (const did of [AUTHOR, BUSY_READER, ENGAGED_READER, BANNED_BUSY]) {
    addMember(db, SPACE, did);
  }
  // Preferences: busy reader = busy, engaged reader = no row (default engaged),
  // banned user = busy (but banned → must be excluded by access filter).
  setUserDefault(db, BUSY_READER, "busy");
  setUserDefault(db, BANNED_BUSY, "busy");
  // Subscriptions: only busy reader + banned user have devices.
  addSubscription(db, BUSY_READER);
  addSubscription(db, BANNED_BUSY);
  addBan(db, SPACE, BANNED_BUSY);
}

describe("push/evaluate — Phase 1 Busy immediate pushes", () => {
  test("busy member gets an immediate push for a live message", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries).toHaveLength(1);
    const d = deliveries[0]!;
    expect(d.userDid).toBe(BUSY_READER);
    expect(d.payload).toEqual({
      type: "message",
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      count: 1,
      roomName: "general",
      authorName: "Alice",
    });
  });

  test("author is never a recipient of their own message", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // Author is also busy + has no subscription, but more importantly must be
    // excluded outright — assert no delivery targets the author.
    setUserDefault(db, AUTHOR, "busy");
    addSubscription(db, AUTHOR);

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries.find((d) => d.userDid === AUTHOR)).toBeUndefined();
  });

  test("engaged member gets no immediate push in Phase 1 (digest is Phase 2)", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // ENGAGED_READER has no preference row → default "engaged" → no immediate push.

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
  });

  test("banned busy user is excluded by the read-access filter", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // BANNED_BUSY is busy + has a subscription, but is banned in the space.
    // roomAccess.canRead must be false → no push (never leak to a banned user).

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries.find((d) => d.userDid === BANNED_BUSY)).toBeUndefined();
  });

  test("busy user with no device subscription is skipped (no subscriptions)", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // BUSY_READER is busy + can read; remove their subscription.
    db.run(
      "delete from readstate.push_subscriptions where user_did = ?",
      [BUSY_READER],
    );

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries).toHaveLength(0);
  });

  test("per-space override to silent suppresses an otherwise-busy user", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // BUSY_READER's default is busy; override this space to silent.
    db.run(
      "insert into readstate.push_preferences (user_did, space_id, level, updated_at) values (?, ?, 'silent', 1)",
      [BUSY_READER, SPACE],
    );

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries).toHaveLength(0);
  });
});