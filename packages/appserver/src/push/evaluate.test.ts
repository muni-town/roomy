import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserDid } from "@roomy-space/sdk";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
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

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(THIS_DIR, "..", "db", "schema.sql");
const READSTATE_SCHEMA_PATH = join(THIS_DIR, "..", "db", "readStateSchema.sql");

const SPACE = "did:web:space.example";
const AUTHOR = "did:plc:alice";
const BUSY_READER = "did:plc:bob";
const ENGAGED_READER = "did:plc:carol";
const BANNED_BUSY = "did:plc:dan";
const QUIET_READER = "did:plc:eve";
const CHANNEL = "01CHANNEL00000000000000000";
const MESSAGE_ID = "01MSGBUSYTEST0000000000AA";

function freshDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  // Attach and create readstate tables inline (same pattern as activityFeed.test.ts)
  db.exec("attach database ':memory:' as readstate");
  db.exec(
    "create table if not exists readstate_schema_version (id integer primary key check (id = 1), version text not null) strict",
  );
  db.exec(
    "create table if not exists readstate.push_subscriptions (user_did text not null, endpoint text not null, p256dh text not null, auth text not null, expiration_time integer, created_at integer not null default (unixepoch() * 1000), updated_at integer not null default (unixepoch() * 1000), primary key (user_did, endpoint)) strict",
  );
  db.exec(
    "create table if not exists readstate.push_user_default (user_did text primary key, level text not null check(level in ('silent','quiet','engaged','busy')) default 'engaged', updated_at integer not null default (unixepoch() * 1000)) strict",
  );
  db.exec(
    "create table if not exists readstate.push_preferences (user_did text not null, space_id text not null, level text not null check(level in ('silent','quiet','engaged','busy')), updated_at integer not null default (unixepoch() * 1000), primary key (user_did, space_id)) strict",
  );
  db.exec(
    "create table if not exists readstate.user_room_participation (user_did text not null, room_id text not null, last_message_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
  );
  db.exec(
    "create table if not exists readstate.notification_state (user_did text not null, room_id text not null, first_unseen_at integer, first_unseen_msg_id text, unseen_count integer not null default 0, notified integer not null default 0 check(notified in (0,1)), pushed_at integer, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
  );
  return toAsyncDb(db);
}

async function seedSpace(db: DbLike, spaceId = SPACE): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  await db.run("insert into comp_space (entity) values (?)", [spaceId]);
}

async function seedUser(db: DbLike, did: string, handle?: string): Promise<void> {
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  await db.run("insert or ignore into comp_user (did, handle) values (?, ?)", [
    did,
    handle ?? null,
  ]);
}

async function seedChannel(
  db: DbLike,
  channelId: string,
  spaceId: string,
  name: string | null,
): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [
    channelId,
    spaceId,
  ]);
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [channelId],
  );
  if (name !== null) {
    await db.run("insert into comp_info (entity, name) values (?, ?)", [
      channelId,
      name,
    ]);
  }
}

async function addMember(db: DbLike, spaceId: string, did: string): Promise<void> {
  await db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
    spaceId,
    did,
  ]);
}

async function addBan(db: DbLike, spaceId: string, did: string): Promise<void> {
  await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
    spaceId,
    did,
  ]);
}

async function addSubscription(db: DbLike, userDid: string): Promise<void> {
  await upsertSubscription(db, {
    userDid,
    endpoint: `https://push.test/${userDid}`,
    p256dh: "p256dh-key",
    auth: "auth-key",
    expirationTime: null,
  });
}
/** Seed a space with members (author, busy, engaged, quiet) + a banned busy user. */
async function seedFixture(db: DbLike): Promise<void> {
  await seedSpace(db);
  for (const did of [AUTHOR, BUSY_READER, ENGAGED_READER, QUIET_READER, BANNED_BUSY]) {
    await seedUser(db, did);
  }
  await seedUser(db, AUTHOR, "alice.test");
  await seedChannel(db, CHANNEL, SPACE, "general");
  // Author display name (comp_info name wins over handle).
  await db.run("insert into comp_info (entity, name) values (?, ?)", [
    AUTHOR,
    "Alice",
  ]);
  // Membership.
  for (const did of [AUTHOR, BUSY_READER, ENGAGED_READER, QUIET_READER, BANNED_BUSY]) {
    await addMember(db, SPACE, did);
  }
  // Preferences: busy reader = busy, engaged reader = no row (default engaged),
  // quiet reader = quiet, banned user = busy (but banned → must be excluded by access filter).
  await setUserDefault(db, BUSY_READER, "busy");
  await setUserDefault(db, QUIET_READER, "quiet");
  await setUserDefault(db, BANNED_BUSY, "busy");
  // Subscriptions: only busy reader + quiet reader + banned user have devices.
  await addSubscription(db, BUSY_READER);
  await addSubscription(db, QUIET_READER);
  await addSubscription(db, BANNED_BUSY);
  await addBan(db, SPACE, BANNED_BUSY);
}

describe("push/evaluate — Busy immediate pushes", () => {
  test("busy member gets an immediate push for a live message", async () => {
    const db = freshDb();
    await seedFixture(db);

    const deliveries = await evaluatePush(db, {
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

  test("author is never a recipient of their own message", async () => {
    const db = freshDb();
    await seedFixture(db);
    // Author is also busy + has no subscription, but more importantly must be
    // excluded outright — assert no delivery targets the author.
    await setUserDefault(db, AUTHOR, "busy");
    await addSubscription(db, AUTHOR);

    const deliveries = await evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries.find((d) => d.userDid === AUTHOR)).toBeUndefined();
  });

  test("engaged member gets no immediate message push (digest path, not per-message)", async () => {
    const db = freshDb();
    await seedFixture(db);
    // ENGAGED_READER has no preference row → default "engaged". They have not
    // participated in the room, so even the digest gate skips them → no
    // delivery of any kind for a single message.
    _resetParticipationBackfillCache();

    const deliveries = await evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
  });

  test("banned busy user is excluded by the read-access filter", async () => {
    const db = freshDb();
    await seedFixture(db);
    // BANNED_BUSY is busy + has a subscription, but is banned in the space.
    // roomAccess.canRead must be false → no push (never leak to a banned user).

    const deliveries = await evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries.find((d) => d.userDid === BANNED_BUSY)).toBeUndefined();
  });

  test("busy user with no device subscription is skipped (no subscriptions)", async () => {
    const db = freshDb();
    await seedFixture(db);
    // BUSY_READER is busy + can read; remove their subscription.
    await db.run(
      "delete from readstate.push_subscriptions where user_did = ?",
      [BUSY_READER],
    );

    const deliveries = await evaluatePush(db, {
      spaceId: SPACE,
      roomId: CHANNEL,
      messageId: MESSAGE_ID,
      authorDid: AUTHOR as UserDid,
      timestamp: 1_000_000,
    });

    expect(deliveries).toHaveLength(0);
  });

  test("per-space override to silent suppresses an otherwise-busy user", async () => {
    const db = freshDb();
    await seedFixture(db);
    // BUSY_READER's default is busy; override this space to silent.
    await db.run(
      "insert into readstate.push_preferences (user_did, space_id, level, updated_at) values (?, ?, 'silent', 1)",
      [BUSY_READER, SPACE],
    );

    const deliveries = await evaluatePush(db, {
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

async function addParticipation(
  db: DbLike,
  userDid: string,
  roomId: string,
  timestamp: number,
): Promise<void> {
  await db.run(
    "insert into readstate.user_room_participation (user_did, room_id, last_message_at, updated_at) values (?, ?, ?, 0)",
    [userDid, roomId, timestamp],
  );
}

async function notifState(
  db: DbLike,
  userDid: string,
  roomId: string,
): Promise<{ unseen_count: number; notified: 0 | 1 } | undefined> {
  const row = await db
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
  test("engaged participant accumulates; 5th message fires an on-event digest", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    // ENGAGED_READER (default engaged) has participated + has a subscription.
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    await addSubscription(db, ENGAGED_READER);

    // Messages 1–4: no digest yet (below threshold), but state accumulates.
    for (let i = 1; i <= 4; i++) {
      const deliveries = await evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toEqual({
      unseen_count: 4,
      notified: 0,
    });

    // 5th message: on-event threshold reached → digest delivery, notified=1.
    const deliveries5 = await evaluatePush(db, msgJob(5));
    const digest = deliveries5.find((d) => d.userDid === ENGAGED_READER);
    expect(digest).toBeDefined();
    expect(digest!.payload.type).toBe("digest");
    expect(digest!.payload.count).toBe(DIGEST_THRESHOLD);
    expect(digest!.payload.roomName).toBe("general");
    expect(digest!.payload.messageId).toBeUndefined();
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toEqual({
      unseen_count: 5,
      notified: 1,
    });
  });

  test("engaged non-participant (never sent a message) gets no digest", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    // ENGAGED_READER has a subscription but NO participation row.
    await addSubscription(db, ENGAGED_READER);

    for (let i = 1; i <= 6; i++) {
      const deliveries = await evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    // Participation gate skips before any notification_state write.
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();
  });

  test("after a digest fires, further messages in the batch do not re-fire", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    await addSubscription(db, ENGAGED_READER);

    // Fire the 5-message threshold.
    for (let i = 1; i <= 5; i++) await evaluatePush(db, msgJob(i));
    expect((await notifState(db, ENGAGED_READER, CHANNEL))!.notified).toBe(1);

    // More messages arrive while the user still hasn't reopened the room.
    const deliveries6 = await evaluatePush(db, msgJob(6));
    const deliveries7 = await evaluatePush(db, msgJob(7));
    expect(deliveries6.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    expect(deliveries7.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    // Per the plan, once notified the row "does nothing" for further messages
    // (one push per batch) — the count is left at the fire-time value and the
    // batch stays quiet until the user reopens the room (which resets it).
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toEqual({
      unseen_count: 5,
      notified: 1,
    });
  });

  test("resetNotificationState (updateSeen) re-arms the batch for a new burst", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    await addSubscription(db, ENGAGED_READER);

    // Fire + notify the first batch.
    for (let i = 1; i <= 5; i++) await evaluatePush(db, msgJob(i));
    expect((await notifState(db, ENGAGED_READER, CHANNEL))!.notified).toBe(1);

    // User reopens the room → updateSeen resets the digest state.
    await resetNotificationState(db, ENGAGED_READER, CHANNEL);
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();

    // A new burst can fire another digest.
    for (let i = 10; i <= 14; i++) await evaluatePush(db, msgJob(i));
    const state = await notifState(db, ENGAGED_READER, CHANNEL);
    expect(state?.notified).toBe(1);
    expect(state?.unseen_count).toBe(5);
  });

  test("quiet level (not mentioned) is skipped like silent", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await setUserDefault(db, ENGAGED_READER, "quiet");
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    await addSubscription(db, ENGAGED_READER);

    for (let i = 1; i <= 6; i++) {
      const deliveries = await evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();
  });

  test("engaged user who can't read the room is excluded (no digest leak)", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    await addSubscription(db, ENGAGED_READER);
    // Ban the engaged reader so roomAccess.canRead is false.
    await addBan(db, SPACE, ENGAGED_READER);

    for (let i = 1; i <= 6; i++) {
      const deliveries = await evaluatePush(db, msgJob(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();
  });
});

// ── Phase 3: Mention routing ───────────────────────────────────────────────

/** Build a createMessage job with a given ordinal and optional mentions. */
function msgJobWithMentions(ordinal: number, mentions?: string[]) {
  const suffix = String(ordinal).padStart(6, "0");
  return {
    spaceId: SPACE,
    roomId: CHANNEL,
    messageId: `01MSGDIGEST${suffix}0000000000`,
    authorDid: AUTHOR as UserDid,
    timestamp: 1_000_000 + ordinal * 1000,
    mentions,
  };
}

describe("push/evaluate — Phase 3 mention routing", () => {
  test("quiet + mentioned → immediate message push", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    // QUIET_READER is quiet by default (set in seedFixture) + has a subscription.
    // The message mentions them → should get an immediate push.
    const deliveries = await evaluatePush(db, msgJobWithMentions(1, [QUIET_READER]));
    const push = deliveries.find((d) => d.userDid === QUIET_READER);
    expect(push).toBeDefined();
    expect(push!.payload.type).toBe("message");
    expect(push!.payload.count).toBe(1);
    expect(push!.payload.roomName).toBe("general");
  });

  test("quiet + not mentioned → no push", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    // QUIET_READER is quiet, message does NOT mention them → no push.
    const deliveries = await evaluatePush(db, msgJobWithMentions(1, [ENGAGED_READER]));
    expect(deliveries.find((d) => d.userDid === QUIET_READER)).toBeUndefined();
  });

  test("engaged + mentioned → immediate message push (not digest)", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    // ENGAGED_READER is default engaged, has no subscription in seedFixture.
    // Give them one, and add participation so the digest path would work.
    await addSubscription(db, ENGAGED_READER);
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);

    // Message mentions them → should get immediate message push, not digest.
    const deliveries = await evaluatePush(db, msgJobWithMentions(1, [ENGAGED_READER]));
    const push = deliveries.find((d) => d.userDid === ENGAGED_READER);
    expect(push).toBeDefined();
    expect(push!.payload.type).toBe("message");
    expect(push!.payload.count).toBe(1);
    // No notification_state row should be created (mention bypasses digest path).
    expect(await notifState(db, ENGAGED_READER, CHANNEL)).toBeUndefined();
  });

  test("engaged + mentioned, below digest threshold → immediate push still fires", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addSubscription(db, ENGAGED_READER);
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);

    // Even with 0 prior unseen messages, a mention fires immediately.
    const deliveries = await evaluatePush(db, msgJobWithMentions(1, [ENGAGED_READER]));
    expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeDefined();
  });

  test("engaged + not mentioned → digest path (unchanged, regression)", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addSubscription(db, ENGAGED_READER);
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);

    // No mentions → digest path. 5 messages should fire a digest.
    for (let i = 1; i <= 4; i++) {
      const deliveries = await evaluatePush(db, msgJobWithMentions(i));
      expect(deliveries.find((d) => d.userDid === ENGAGED_READER)).toBeUndefined();
    }
    const deliveries5 = await evaluatePush(db, msgJobWithMentions(5));
    const digest = deliveries5.find((d) => d.userDid === ENGAGED_READER);
    expect(digest).toBeDefined();
    expect(digest!.payload.type).toBe("digest");
  });

  test("busy + mentioned → immediate push (unchanged, regression)", async () => {
    const db = freshDb();
    await seedFixture(db);
    // BUSY_READER is busy. Mention doesn't change busy behaviour — they get
    // the same immediate push regardless.
    const deliveries = await evaluatePush(db, msgJobWithMentions(1, [BUSY_READER]));
    expect(deliveries.find((d) => d.userDid === BUSY_READER)).toBeDefined();
  });

  test("silent + mentioned → no push (mention doesn't override silent)", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    // Override BUSY_READER to silent for this space.
    await db.run(
      "insert into readstate.push_preferences (user_did, space_id, level, updated_at) values (?, ?, 'silent', 1)",
      [BUSY_READER, SPACE],
    );

    const deliveries = await evaluatePush(db, msgJobWithMentions(1, [BUSY_READER]));
    expect(deliveries.find((d) => d.userDid === BUSY_READER)).toBeUndefined();
  });

  test("author mentioned → no self-push (author exclusion runs first)", async () => {
    const db = freshDb();
    await seedFixture(db);
    // Author mentions themselves — still excluded by the `did === authorDid` check.
    const deliveries = await evaluatePush(db, msgJobWithMentions(1, [AUTHOR]));
    expect(deliveries.find((d) => d.userDid === AUTHOR)).toBeUndefined();
  });

  test("empty mentions array → no mention routing (behaves like undefined)", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addSubscription(db, ENGAGED_READER);
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);

    // Empty mentions array — no one is mentioned. Engaged reader gets digest path.
    for (let i = 1; i <= 4; i++) {
      await evaluatePush(db, msgJobWithMentions(i, []));
    }
    const deliveries5 = await evaluatePush(db, msgJobWithMentions(5, []));
    const digest = deliveries5.find((d) => d.userDid === ENGAGED_READER);
    expect(digest).toBeDefined();
    expect(digest!.payload.type).toBe("digest");
  });
});

describe("notificationState — upsert threshold logic", () => {
  test("inserts a fresh batch on first message", async () => {
    const db = freshDb();
    const out = await upsertNotificationState(db, "did:plc:x", "room1", 1000, "m1");
    expect(out).toEqual({ fireNow: false, unseenCount: 1 });
    expect(await notifState(db, "did:plc:x", "room1")).toEqual({
      unseen_count: 1,
      notified: 0,
    });
  });

  test("fires exactly at the threshold and marks notified", async () => {
    const db = freshDb();
    let out;
    for (let i = 1; i <= DIGEST_THRESHOLD - 1; i++) {
      out = await upsertNotificationState(db, "did:plc:x", "room1", i * 1000, `m${i}`);
      expect(out!.fireNow).toBe(false);
    }
    out = await upsertNotificationState(db, "did:plc:x", "room1", DIGEST_THRESHOLD * 1000, `m${DIGEST_THRESHOLD}`);
    expect(out!.fireNow).toBe(true);
    expect(out!.unseenCount).toBe(DIGEST_THRESHOLD);
    expect((await notifState(db, "did:plc:x", "room1"))!.notified).toBe(1);
  });

  test("no-op once notified (one push per batch)", async () => {
    const db = freshDb();
    for (let i = 1; i <= DIGEST_THRESHOLD; i++) {
      await upsertNotificationState(db, "did:plc:x", "room1", i * 1000, `m${i}`);
    }
    // Already notified; a 6th message does not re-arm.
    const out = await upsertNotificationState(db, "did:plc:x", "room1", 6_000, "m6");
    expect(out.fireNow).toBe(false);
    expect(await notifState(db, "did:plc:x", "room1")).toEqual({
      unseen_count: DIGEST_THRESHOLD,
      notified: 1,
    });
  });
});

// ── Notification icons (avatars) ──────────────────────────────────────────

describe("push/evaluate — notification icons (avatars)", () => {
  test("busy message push carries the sender avatar as icon", async () => {
    const db = freshDb();
    await seedFixture(db);
    // Give the author an avatar (atblob ref). Space has none.
    await db.run("update comp_info set avatar = ? where entity = ?", [
      "atblob://did:plc:alice/cidA",
      AUTHOR,
    ]);

    const deliveries = await evaluatePush(db, {
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

  test("busy message push falls back to the space avatar when sender has none", async () => {
    const db = freshDb();
    await seedFixture(db);
    // Author has no avatar; give the space one.
    await db.run("insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)", [
      SPACE,
      "My Space",
      "https://cdn.example/space.png",
    ]);

    const deliveries = await evaluatePush(db, {
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

  test("no icon field when neither sender nor space has an avatar", async () => {
    const db = freshDb();
    await seedFixture(db);
    // seedFixture sets no avatars.

    const deliveries = await evaluatePush(db, {
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

  test("digest push carries the sender avatar as icon (space fallback)", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    await addSubscription(db, ENGAGED_READER);
    // Give the author (sender) an avatar; space has none → digest icon should
    // be the sender's (digests use sender avatar → space, like message pushes).
    await db.run("update comp_info set avatar = ? where entity = ?", [
      "atblob://did:plc:alice/cidA",
      AUTHOR,
    ]);

    let digest: { payload: { icon?: string } } | undefined;
    for (let i = 1; i <= 5; i++) {
      const deliveries = await evaluatePush(db, msgJob(i));
      digest = deliveries.find((d) => d.userDid === ENGAGED_READER) as
        | { payload: { icon?: string } }
        | undefined;
    }
    expect(digest).toBeDefined();
    expect(digest!.payload.icon).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:alice/cidA",
    );
  });

  test("digest icon falls back to the space avatar when the sender has none", async () => {
    const db = freshDb();
    await seedFixture(db);
    _resetParticipationBackfillCache();
    await addParticipation(db, ENGAGED_READER, CHANNEL, 500_000);
    await addSubscription(db, ENGAGED_READER);
    // Author has no avatar; give the space one (a plain URL that loads).
    await db.run(
      "insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)",
      [SPACE, "My Space", "https://cdn.example/space.png"],
    );

    let digest: { payload: { icon?: string } } | undefined;
    for (let i = 1; i <= 5; i++) {
      const deliveries = await evaluatePush(db, msgJob(i));
      digest = deliveries.find((d) => d.userDid === ENGAGED_READER) as
        | { payload: { icon?: string } }
        | undefined;
    }
    expect(digest).toBeDefined();
    expect(digest!.payload.icon).toBe("https://cdn.example/space.png");
  });
});
