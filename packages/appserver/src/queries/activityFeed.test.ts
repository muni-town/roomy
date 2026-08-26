/**
 * Tests for the activity feed query helper.
 *
 * Covers:
 *   - Basic feed assembly (messages, authors, unread counts)
 *   - Cursor pagination (ties, has-more detection)
 *   - Space filter vs. all-joined-spaces
 *   - Deleted room exclusion
 *   - Missing/deleted messages gracefully skipped
 *   - Empty feed for empty DB
 *
 * Phase 3 (per-space read cutover): `selectActivityFeed` fans out to per-space
 * DBs. Space-scoped rows (entities, comp_space, comp_room, comp_info, edges,
 * activity_item) are seeded into the per-space DB via `openSpaceDb`;
 * `joinedSpace` edges go into the global DB via `openGlobalDb`; unread counts
 * go into the read-state DB via `openReadStateDb`. `selectActivityFeed` takes
 * the read-state handle as its first argument.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { selectActivityFeed } from "./activityFeed.ts";
import { _setTestGetProfiles } from "./profileStore.ts";
import { setUserSpaceMembership } from "./userSpaceMembership.ts";

const SPACE = "did:web:space.example";
const OTHER_SPACE = "did:web:other-space.example";
const USER = "did:plc:alice";

const CHANNEL = "01CHANNEL00000000000000000";
const THREAD_A = "01THREADA00000000000000000".slice(0, 26);
const THREAD_B = "01THREADB00000000000000000".slice(0, 26);
const THREAD_C = "01THREADC00000000000000000".slice(0, 26);

let msgCounter = 0;

/**
 * Generate a ULID that encodes a specific timestamp.
 * First 10 chars = Crockford base32 timestamp, next 16 = deterministic suffix.
 */
function ulidForTimestamp(ts: number): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = ts;
  let encoded = "";
  for (let i = 0; i < 10; i++) {
    encoded = chars[remaining % 32]! + encoded;
    remaining = Math.floor(remaining / 32);
  }
  const suffix = String(msgCounter++).padStart(16, "0").slice(0, 16);
  return encoded + suffix;
}

/**
 * Seed the worker-backed DBs for the Phase 3 fan-out read path:
 *   - space-scoped rows are seeded into the per-space DBs
 *   - `joinedSpace` edges into the global DB
 *   - unread counts into the read-state DB
 *
 * Returns the read-state handle, which `selectActivityFeed` takes as its
 * first argument (used only for the read-state unread-count query).
 */
function setup(): { readState: DbLike } {
  closeDb();
  openDb({ path: ":memory:" });
  // Hermetic: without a stub, on-demand profile hydration in
  // selectActivityFeed hits live api.bsky.app fetches.
  _setTestGetProfiles(async () => []);
  const readState = openReadStateDb();
  return { readState };
}

async function seedSpace(spaceId: string) {
  const db = openSpaceDb(spaceId);
  await db.run("insert into entities (id, stream_id) values (?, ?)", [spaceId, spaceId]);
  await db.run("insert into comp_space (entity) values (?)", [spaceId]);
  await db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
    spaceId,
    spaceId === SPACE ? "Test Space" : "Other Space",
    null,
  ]);
}

async function seedUser(spaceId: string, did: string) {
  const db = openSpaceDb(spaceId);
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  await db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
    did,
    did.split(":").pop() ?? did,
    null,
  ]);
}

async function seedJoinedSpace(userDid: string, spaceId: string) {
  await setUserSpaceMembership(
    openReadStateDb(),
    userDid as UserDid,
    spaceId as StreamDid,
    "joined",
    "test",
    "01TEST0000000000000000000000",
  );
}

async function seedRoom(
  spaceId: string,
  roomId: string,
  label: string,
  name: string | null,
  parentChannelId: string | null = null,
  parentChannelName: string | null = null,
) {
  const db = openSpaceDb(spaceId);
  await db.run("insert into entities (id, stream_id) values (?, ?)", [roomId, spaceId]);
  await db.run(
    "insert into comp_room (entity, label, default_access) values (?, ?, 'readwrite')",
    [roomId, label],
  );
  if (name !== null) {
    await db.run("insert into comp_info (entity, name) values (?, ?)", [roomId, name]);
  }
  if (parentChannelId !== null) {
    await db.run(
      `insert into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
      [parentChannelId, roomId],
    );
  }
}

async function postMessage(
  spaceId: string,
  roomId: string,
  authorDid: string,
  ts: number,
  content: string = "hello",
): Promise<string> {
  const db = openSpaceDb(spaceId);
  const msgId = ulidForTimestamp(ts);
  await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    msgId,
    spaceId,
    roomId,
  ]);
  await db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
    [msgId, Buffer.from(content), msgId, ts],
  );
  await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    msgId,
    authorDid,
  ]);
  return msgId;
}

async function seedActivityItem(
  spaceId: string,
  roomId: string,
  isThread: number,
  lastActivityAt: number,
  messageIds: string[],
  roomName: string | null = null,
  spaceName: string | null = null,
  spaceAvatar: string | null = null,
  parentChannelId: string | null = null,
  parentChannelName: string | null = null,
) {
  const db = openSpaceDb(spaceId);
  await db.run(
    `insert into activity_item
       (room_id, space_id, is_thread, parent_channel_id, parent_channel_name,
        last_activity_at, recent_message_ids,
        room_name, space_name, space_avatar,
        created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))`,
    [
      roomId,
      spaceId,
      isThread,
      parentChannelId,
      parentChannelName,
      lastActivityAt,
      JSON.stringify(messageIds),
      roomName,
      spaceName,
      spaceAvatar,
    ],
  );
}

async function seedUnreadCount(
  userDid: string,
  roomId: string,
  count: number,
) {
  const db = openReadStateDb();
  await db.run(
    "insert into read_positions (user_did, room_id, seen_up_to, unread_count) values (?, ?, ?, ?)",
    [userDid, roomId, "idx-0", count],
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("selectActivityFeed", () => {
  describe("basic feed assembly", () => {
    test("returns feed items with messages and authors", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const msgId = await postMessage(SPACE, CHANNEL, USER, ts, "Hello world");
      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msgId], "general", "Test Space");
      await seedUnreadCount(USER, CHANNEL, 3);

      const { feed, cursor } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.threadId).toBe(CHANNEL);
      expect(feed[0]!.threadName).toBe("general");
      expect(feed[0]!.spaceId).toBe(SPACE);
      expect(feed[0]!.spaceName).toBe("Test Space");
      expect(feed[0]!.activityType).toBe("message");
      expect(feed[0]!.unreadCount).toBe(3);
      expect(feed[0]!.messages).toHaveLength(1);
      expect(feed[0]!.messages[0]!.content).toBe("Hello world");
      expect(feed[0]!.messages[0]!.author.did).toBe(USER);
      expect(feed[0]!.lastActivityAt).toBe(new Date(ts).toISOString());
      expect(cursor).toBeNull();
    });

    test("includes parent channel info for thread items", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(SPACE, THREAD_A, "space.roomy.thread", "My Thread", CHANNEL, "general");

      const ts = 1_717_536_000_000;
      const msgId = await postMessage(SPACE, THREAD_A, USER, ts);
      await seedActivityItem(
        SPACE, THREAD_A, 1, ts, [msgId],
        "My Thread", "Test Space", null, CHANNEL, "general",
      );

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.channelId).toBe(CHANNEL);
      expect(feed[0]!.channelName).toBe("general");
    });

    test("returns empty feed when no activity exists", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);

      const { feed, cursor } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(0);
      expect(cursor).toBeNull();
    });
  });

  describe("cursor pagination", () => {
    test("returns cursor when more pages exist", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);

      // Two rooms with different timestamps.
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(SPACE, THREAD_A, "space.roomy.thread", "Thread A");

      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_000_001;
      const msg1 = await postMessage(SPACE, CHANNEL, USER, ts1);
      const msg2 = await postMessage(SPACE, THREAD_A, USER, ts2);

      await seedActivityItem(SPACE, CHANNEL, 0, ts1, [msg1], "general", "Test Space");
      await seedActivityItem(SPACE, THREAD_A, 1, ts2, [msg2], "Thread A", "Test Space");

      // Limit 1 → should return 1 item + cursor.
      const { feed, cursor } = await selectActivityFeed(readState, USER, {
        limit: 1,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      // Newest first: THREAD_A (ts2) should be first.
      expect(feed[0]!.threadId).toBe(THREAD_A);
      expect(cursor).toBe(`${ts2}::${THREAD_A}`);
    });

    test("cursor pagination returns the next page", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);

      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(SPACE, THREAD_A, "space.roomy.thread", "Thread A");

      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_000_001;
      const msg1 = await postMessage(SPACE, CHANNEL, USER, ts1);
      const msg2 = await postMessage(SPACE, THREAD_A, USER, ts2);

      await seedActivityItem(SPACE, CHANNEL, 0, ts1, [msg1], "general", "Test Space");
      await seedActivityItem(SPACE, THREAD_A, 1, ts2, [msg2], "Thread A", "Test Space");

      // Page 1: limit 1.
      const page1 = await selectActivityFeed(readState, USER, {
        limit: 1,
        cursor: null,
      });
      expect(page1.feed).toHaveLength(1);
      expect(page1.feed[0]!.threadId).toBe(THREAD_A);
      expect(page1.cursor).not.toBeNull();

      // Page 2: use cursor from page 1.
      const page2 = await selectActivityFeed(readState, USER, {
        limit: 1,
        cursor: page1.cursor,
      });
      expect(page2.feed).toHaveLength(1);
      expect(page2.feed[0]!.threadId).toBe(CHANNEL);
      expect(page2.cursor).toBeNull();
    });

    test("handles ties (same last_activity_at) correctly", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);

      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(SPACE, THREAD_A, "space.roomy.thread", "Thread A");

      const ts = 1_717_536_000_000; // same timestamp
      const msg1 = await postMessage(SPACE, CHANNEL, USER, ts);
      const msg2 = await postMessage(SPACE, THREAD_A, USER, ts);

      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msg1], "general", "Test Space");
      await seedActivityItem(SPACE, THREAD_A, 1, ts, [msg2], "Thread A", "Test Space");

      // Limit 1 → should return one item with a cursor.
      const page1 = await selectActivityFeed(readState, USER, {
        limit: 1,
        cursor: null,
      });
      expect(page1.feed).toHaveLength(1);
      expect(page1.cursor).not.toBeNull();

      // Page 2 should return the other room.
      const page2 = await selectActivityFeed(readState, USER, {
        limit: 1,
        cursor: page1.cursor,
      });
      expect(page2.feed).toHaveLength(1);
      expect(page2.feed[0]!.threadId).not.toBe(page1.feed[0]!.threadId);
      expect(page2.cursor).toBeNull();
    });
  });

  describe("space filter", () => {
    test("filters to a single space when spaceId is provided", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedSpace(OTHER_SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedJoinedSpace(USER, OTHER_SPACE);
      await seedUser(OTHER_SPACE, USER);

      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(OTHER_SPACE, THREAD_A, "space.roomy.thread", "Other Thread");

      const ts = 1_717_536_000_000;
      const msg1 = await postMessage(SPACE, CHANNEL, USER, ts);
      const msg2 = await postMessage(OTHER_SPACE, THREAD_A, USER, ts);

      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msg1], "general", "Test Space");
      await seedActivityItem(OTHER_SPACE, THREAD_A, 1, ts, [msg2], "Other Thread", "Other Space");

      // Filter to SPACE only.
      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
        spaceId: SPACE,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.spaceId).toBe(SPACE);
    });

    test("aggregates across all joined spaces when no spaceId", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedSpace(OTHER_SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedJoinedSpace(USER, OTHER_SPACE);
      await seedUser(OTHER_SPACE, USER);

      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(OTHER_SPACE, THREAD_A, "space.roomy.thread", "Other Thread");

      const ts = 1_717_536_000_000;
      const msg1 = await postMessage(SPACE, CHANNEL, USER, ts);
      const msg2 = await postMessage(OTHER_SPACE, THREAD_A, USER, ts);

      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msg1], "general", "Test Space");
      await seedActivityItem(OTHER_SPACE, THREAD_A, 1, ts, [msg2], "Other Thread", "Other Space");

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(2);
    });

    test("excludes spaces the user has not joined", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedSpace(OTHER_SPACE);
      await seedUser(SPACE, USER);
      await seedUser(OTHER_SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      // Not joined OTHER_SPACE

      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(OTHER_SPACE, THREAD_A, "space.roomy.thread", "Other Thread");

      const ts = 1_717_536_000_000;
      const msg1 = await postMessage(SPACE, CHANNEL, USER, ts);
      const msg2 = await postMessage(OTHER_SPACE, THREAD_A, USER, ts);

      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msg1], "general", "Test Space");
      await seedActivityItem(OTHER_SPACE, THREAD_A, 1, ts, [msg2], "Other Thread", "Other Space");

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.spaceId).toBe(SPACE);
    });
  });

  describe("deleted room exclusion", () => {
    test("excludes rooms marked as deleted", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);

      // Room with deleted=1
      const db = openSpaceDb(SPACE);
      await db.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
      await db.run(
        "insert into comp_room (entity, label, default_access, deleted) values (?, 'space.roomy.channel', 'readwrite', 1)",
        [CHANNEL],
      );

      const ts = 1_717_536_000_000;
      const msgId = await postMessage(SPACE, CHANNEL, USER, ts);
      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msgId], "deleted-room", "Test Space");

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(0);
    });

    test("includes rooms with deleted=0 or null", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);

      // Room with deleted=0
      const db = openSpaceDb(SPACE);
      await db.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
      await db.run(
        "insert into comp_room (entity, label, default_access, deleted) values (?, 'space.roomy.channel', 'readwrite', 0)",
        [CHANNEL],
      );

      const ts = 1_717_536_000_000;
      const msgId = await postMessage(SPACE, CHANNEL, USER, ts);
      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msgId], "active-room", "Test Space");

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
    });
  });

  describe("message handling", () => {
    test("skips message IDs that no longer exist (deleted messages)", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const msgId = await postMessage(SPACE, CHANNEL, USER, ts, "I exist");

      // Store a second message ID that doesn't exist in entities.
      const ghostId = "01GHOST00000000000000000000";
      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msgId, ghostId], "general", "Test Space");

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.messages).toHaveLength(1);
      expect(feed[0]!.messages[0]!.id).toBe(msgId);
    });

    test("returns empty messages array when all message IDs are gone", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const ghostId = "01GHOST00000000000000000000";
      await seedActivityItem(SPACE, CHANNEL, 0, ts, [ghostId], "general", "Test Space");

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(1);
      expect(feed[0]!.messages).toHaveLength(0);
    });
  });

  describe("unread counts", () => {
    test("returns 0 for rooms with no readstate row", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");

      const ts = 1_717_536_000_000;
      const msgId = await postMessage(SPACE, CHANNEL, USER, ts);
      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msgId], "general", "Test Space");
      // No readstate row for this room.

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed[0]!.unreadCount).toBe(0);
    });

    test("returns correct unread counts per room", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "general");
      await seedRoom(SPACE, THREAD_A, "space.roomy.thread", "Thread A");

      const ts = 1_717_536_000_000;
      const msg1 = await postMessage(SPACE, CHANNEL, USER, ts);
      const msg2 = await postMessage(SPACE, THREAD_A, USER, ts);

      await seedActivityItem(SPACE, CHANNEL, 0, ts, [msg1], "general", "Test Space");
      await seedActivityItem(SPACE, THREAD_A, 1, ts, [msg2], "Thread A", "Test Space");
      await seedUnreadCount(USER, CHANNEL, 5);
      await seedUnreadCount(USER, THREAD_A, 2);

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      const channelItem = feed.find((f) => f.threadId === CHANNEL)!;
      const threadItem = feed.find((f) => f.threadId === THREAD_A)!;
      expect(channelItem.unreadCount).toBe(5);
      expect(threadItem.unreadCount).toBe(2);
    });
  });

  describe("ordering", () => {
    test("returns items newest-first by last_activity_at", async () => {
      const { readState } = setup();
      await seedSpace(SPACE);
      await seedUser(SPACE, USER);
      await seedJoinedSpace(USER, SPACE);

      await seedRoom(SPACE, THREAD_A, "space.roomy.thread", "Old");
      await seedRoom(SPACE, CHANNEL, "space.roomy.channel", "New");
      await seedRoom(SPACE, THREAD_B, "space.roomy.thread", "Middle");

      const ts1 = 1_000;
      const ts2 = 3_000;
      const ts3 = 2_000;
      const msg1 = await postMessage(SPACE, THREAD_A, USER, ts1);
      const msg2 = await postMessage(SPACE, CHANNEL, USER, ts2);
      const msg3 = await postMessage(SPACE, THREAD_B, USER, ts3);

      await seedActivityItem(SPACE, THREAD_A, 1, ts1, [msg1], "Old", "Test Space");
      await seedActivityItem(SPACE, CHANNEL, 0, ts2, [msg2], "New", "Test Space");
      await seedActivityItem(SPACE, THREAD_B, 1, ts3, [msg3], "Middle", "Test Space");

      const { feed } = await selectActivityFeed(readState, USER, {
        limit: 50,
        cursor: null,
      });

      expect(feed).toHaveLength(3);
      expect(feed[0]!.threadName).toBe("New");
      expect(feed[1]!.threadName).toBe("Middle");
      expect(feed[2]!.threadName).toBe("Old");
    });
  });
});

afterEach(() => {
  _setTestGetProfiles(null);
  closeDb();
});
