import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { attachInMemoryReadState } from "../db/readStateDb.ts";
import { evaluatePush } from "./evaluate.ts";
import { setUserDefault } from "../queries/pushPreferences.ts";
import { upsertSubscription } from "../queries/pushSubscriptions.ts";
import {
  upsertNotificationState,
  resetNotificationState,
  DIGEST_THRESHOLD,
} from "../queries/notificationState.ts";
import {
  upsertUserRoomParticipation,
  _resetParticipationBackfillCache,
} from "../queries/userRoomParticipation.ts";

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

describe("push/evaluate — Busy immediate pushes", () => {
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

  test("engaged member gets no immediate message push (digest path, not per-message)", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // ENGAGED_READER has no preference row → default "engaged". They have not
    // participated in the room, so even the digest gate skips them → no
    // delivery of any kind for a single message.
    _resetParticipationBackfillCache();

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

// ── Phase 2: Engaged digest ───────────────────────────────────────────────

function addParticipation(
  db: Database,
  userDid: string,
  roomId: string,
  timestamp: number,
): void {
  db.run(
    "insert into readstate.user_room_participation (user_did, room_id, last_message_at, updated_at) values (?, ?, ?, 0)",
    [userDid, roomId, timestamp],
  );
}

function notifState(
  db: Database,
  userDid: string,
  roomId: string,
): { unseen_count: number; notified: 0 | 1 } | undefined {
  const row = db
    .query<{ unseen_count: number; notified: 0 | 1 }, [string, string]>(
      "select unseen_count, notified from readstate.notification_state where user_did = ? and room_id = ?",
    )
    .get(userDid, roomId);
  return row ?? undefined;
}

/** Build a createMessage job with a given ordinal (distinct id + timestamp). */
function msgJob(ordinal: number) {
  // Pad ordinal into a fixed-width suffix so ids stay distinct + sortable.
  const suffix = String(ordinal).padStart(6, "0");
  return {
    spaceId: SPACE,
    roomId: CHANNEL,
    messageId: `01MSGDIGEST${suffix}0000000000`,
    authorDid: AUTHOR as UserDid,
    timestamp: 1_000_000 + ordinal * 1000,
  };
}

describe("push/evaluate — Engaged digest path", () => {
  test("engaged participant accumulates; 5th message fires an on-event digest", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    // ENGAGED_READER (default engaged) has participated + has a subscription.
    addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    addSubscription(db, ENGAGED_READER);

    // Messages 1–4: no digest yet (below threshold), but state accumulates.
    for (let i = 1; i <= 4; i++) {
      const deliveries = evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    expect(notifState(db, ENGAGED_READER, CHANNEL)).toEqual({
      unseen_count: 4,
      notified: 0,
    });

    // 5th message: on-event threshold reached → digest delivery, notified=1.
    const deliveries5 = evaluatePush(db, msgJob(5));
    const digest = deliveries5.find((d) => d.userDid === ENGAGED_READER);
    expect(digest).toBeDefined();
    expect(digest!.payload.type).toBe("digest");
    expect(digest!.payload.count).toBe(DIGEST_THRESHOLD);
    expect(digest!.payload.roomName).toBe("general");
    expect(digest!.payload.messageId).toBeUndefined();
    expect(notifState(db, ENGAGED_READER, CHANNEL)).toEqual({
      unseen_count: 5,
      notified: 1,
    });
  });

  test("engaged non-participant (never sent a message) gets no digest", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    // ENGAGED_READER has a subscription but NO participation row.
    addSubscription(db, ENGAGED_READER);

    for (let i = 1; i <= 6; i++) {
      const deliveries = evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    // Participation gate skips before any notification_state write.
    expect(notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();
  });

  test("after a digest fires, further messages in the batch do not re-fire", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    addSubscription(db, ENGAGED_READER);

    // Fire the 5-message threshold.
    for (let i = 1; i <= 5; i++) evaluatePush(db, msgJob(i));
    expect(notifState(db, ENGAGED_READER, CHANNEL)!.notified).toBe(1);

    // More messages arrive while the user still hasn't reopened the room.
    const deliveries6 = evaluatePush(db, msgJob(6));
    const deliveries7 = evaluatePush(db, msgJob(7));
    expect(deliveries6.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    expect(deliveries7.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    // Per the plan, once notified the row "does nothing" for further messages
    // (one push per batch) — the count is left at the fire-time value and the
    // batch stays quiet until the user reopens the room (which resets it).
    expect(notifState(db, ENGAGED_READER, CHANNEL)).toEqual({
      unseen_count: 5,
      notified: 1,
    });
  });

  test("resetNotificationState (updateSeen) re-arms the batch for a new burst", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    addSubscription(db, ENGAGED_READER);

    // Fire + notify the first batch.
    for (let i = 1; i <= 5; i++) evaluatePush(db, msgJob(i));
    expect(notifState(db, ENGAGED_READER, CHANNEL)!.notified).toBe(1);

    // User reopens the room → updateSeen resets the digest state.
    resetNotificationState(db, ENGAGED_READER, CHANNEL);
    expect(notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();

    // A new burst can fire another digest.
    for (let i = 10; i <= 14; i++) evaluatePush(db, msgJob(i));
    const state = notifState(db, ENGAGED_READER, CHANNEL);
    expect(state?.notified).toBe(1);
    expect(state?.unseen_count).toBe(5);
  });

  test("quiet level is skipped like silent (no mentions path yet)", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    setUserDefault(db, ENGAGED_READER, "quiet");
    addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    addSubscription(db, ENGAGED_READER);

    for (let i = 1; i <= 6; i++) {
      const deliveries = evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    expect(notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();
  });

  test("engaged user who can't read the room is excluded (no digest leak)", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    addSubscription(db, ENGAGED_READER);
    // Ban the engaged reader so roomAccess.canRead is false.
    addBan(db, SPACE, ENGAGED_READER);

    for (let i = 1; i <= 6; i++) {
      const deliveries = evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    expect(notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();
  });
});

describe("notificationState — upsert threshold logic", () => {
  test("inserts a fresh batch on first message", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    const out = upsertNotificationState(db, "did:plc:x", "room1", 1000, "m1");
    expect(out).toEqual({ fireNow: false, unseenCount: 1 });
    expect(notifState(db, "did:plc:x", "room1")).toEqual({
      unseen_count: 1,
      notified: 0,
    });
  });

  test("fires exactly at the threshold and marks notified", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    let out;
    for (let i = 1; i <= DIGEST_THRESHOLD - 1; i++) {
      out = upsertNotificationState(db, "did:plc:x", "room1", i * 1000, `m${i}`);
      expect(out!.fireNow).toBe(false);
    }
    out = upsertNotificationState(db, "did:plc:x", "room1", DIGEST_THRESHOLD * 1000, `m${DIGEST_THRESHOLD}`);
    expect(out!.fireNow).toBe(true);
    expect(out!.unseenCount).toBe(DIGEST_THRESHOLD);
    expect(notifState(db, "did:plc:x", "room1")!.notified).toBe(1);
  });

  test("no-op once notified (one push per batch)", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    for (let i = 1; i <= DIGEST_THRESHOLD; i++) {
      upsertNotificationState(db, "did:plc:x", "room1", i * 1000, `m${i}`);
    }
    // Already notified; a 6th message does not re-arm.
    const out = upsertNotificationState(db, "did:plc:x", "room1", 6_000, "m6");
    expect(out.fireNow).toBe(false);
    expect(notifState(db, "did:plc:x", "room1")).toEqual({
      unseen_count: DIGEST_THRESHOLD,
      notified: 1,
    });
  });
});

// ── Notification icons (avatars) ──────────────────────────────────────────

describe("push/evaluate — notification icons (avatars)", () => {
  test("busy message push carries the sender avatar as icon", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // Give the author an avatar (atblob ref). Space has none.
    db.run("update comp_info set avatar = ? where entity = ?", [
      "atblob://did:plc:alice/cidA",
      AUTHOR,
    ]);

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    const d = deliveries.find((x) => x.userDid === BUSY_READER);
    expect(d).toBeDefined();
    expect(d!.payload.icon).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:alice/cidA",
    );
  });

  test("busy message push falls back to the space avatar when sender has none", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // Author has no avatar; give the space one.
    db.run("insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)", [
      SPACE,
      "My Space",
      "https://cdn.example/space.png",
    ]);

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    const d = deliveries.find((x) => x.userDid === BUSY_READER);
    expect(d).toBeDefined();
    expect(d!.payload.icon).toBe("https://cdn.example/space.png");
  });

  test("no icon field when neither sender nor space has an avatar", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    // seedFixture sets no avatars.

    const deliveries = evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    const d = deliveries.find((x) => x.userDid === BUSY_READER);
    expect(d).toBeDefined();
    expect("icon" in d!.payload).toBe(false);
  });

  test("digest push carries the sender avatar as icon (space fallback)", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    addSubscription(db, ENGAGED_READER);
    // Give the author (sender) an avatar; space has none → digest icon should
    // be the sender's (digests use sender avatar → space, like message pushes).
    db.run("update comp_info set avatar = ? where entity = ?", [
      "atblob://did:plc:alice/cidA",
      AUTHOR,
    ]);

    let digest: { payload: { icon?: string } } | undefined;
    for (let i = 1; i <= 5; i++) {
      const deliveries = evaluatePush(db, msgJob(i));
      digest = deliveries.find((d) => d.userDid === ENGAGED_READER) as
        | { payload: { icon?: string } }
        | undefined;
    }
    expect(digest).toBeDefined();
    expect(digest!.payload.icon).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:alice/cidA",
    );
  });

  test("digest icon falls back to the space avatar when the sender has none", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedFixture(db);
    _resetParticipationBackfillCache();
    addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    addSubscription(db, ENGAGED_READER);
    // Author has no avatar; give the space one (a plain URL that loads).
    db.run(
      "insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)",
      [SPACE, "My Space", "https://cdn.example/space.png"],
    );

    let digest: { payload: { icon?: string } } | undefined;
    for (let i = 1; i <= 5; i++) {
      const deliveries = evaluatePush(db, msgJob(i));
      digest = deliveries.find((d) => d.userDid === ENGAGED_READER) as
        | { payload: { icon?: string } }
        | undefined;
    }
    expect(digest).toBeDefined();
    expect(digest!.payload.icon).toBe("https://cdn.example/space.png");
  });
});