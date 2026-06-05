/**
 * Tests for activity item upsert logic.
 *
 * Covers:
 *   - Slow path: first message in a room (channel + thread)
 *   - Fast path: subsequent messages (dedup, cap at 5)
 *   - Backfill: events arrive in order
 *   - Room metadata: is_thread, parent_channel, space/room names
 *   - decodeMessageTimestamp
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../db/db.ts";
import { upsertActivityItem, decodeMessageTimestamp } from "./activityItem.ts";
import { decodeTime } from "ulidx";

/** Create a fresh in-memory DB for testing. */
function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

const SPACE = "did:web:space.example";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREADA00000000000000000".slice(0, 26);

function seedSpace(db: Database) {
  db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  db.run("insert into comp_space (entity) values (?)", [SPACE]);
  db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
    SPACE,
    "Test Space",
    "https://example.com/avatar.png",
  ]);
}

function seedChannel(db: Database) {
  db.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );
  db.run("insert into comp_info (entity, name) values (?, ?)", [
    CHANNEL,
    "general",
  ]);
}

function seedThread(db: Database) {
  db.run("insert into entities (id, stream_id) values (?, ?)", [THREAD, SPACE]);
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD],
  );
  db.run("insert into comp_info (entity, name) values (?, ?)", [
    THREAD,
    "My Thread",
  ]);
  db.run(
    `insert into edges (head, tail, label, payload)
     values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD],
  );
}

/**
 * Generate a ULID that encodes a specific timestamp.
 * ULIDs are 26-char Crockford base32; the first 10 chars encode the timestamp.
 * We use a known-good ULID prefix and vary the random suffix.
 */
let msgCounter = 0;
function ulidForTimestamp(ts: number): string {
  // Encode timestamp as Crockford base32 (10 chars).
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let remaining = ts;
  let encoded = "";
  for (let i = 0; i < 10; i++) {
    encoded = chars[remaining % 32]! + encoded;
    remaining = Math.floor(remaining / 32);
  }
  // Random suffix (16 chars) — use a counter for determinism.
  const suffix = String(msgCounter++).padStart(16, "0").slice(0, 16);
  return encoded + suffix;
}

describe("upsertActivityItem", () => {
  describe("slow path (first message in room)", () => {
    test("creates a row for a channel room", () => {
      const db = freshDb();
      seedSpace(db);
      seedChannel(db);

      const ts = 1_717_536_000_000;
      const msgId = ulidForTimestamp(ts);
      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msgId });

      const row = db
        .query<
          {
            room_id: string;
            space_id: string;
            is_thread: number;
            parent_channel_id: string | null;
            parent_channel_name: string | null;
            last_activity_at: number;
            recent_message_ids: string;
            room_name: string | null;
            space_name: string | null;
            space_avatar: string | null;
          },
          [string]
        >("select * from activity_item where room_id = ?")
        .get(CHANNEL);

      expect(row).not.toBeNull();
      expect(row!.room_id).toBe(CHANNEL);
      expect(row!.space_id).toBe(SPACE);
      expect(row!.is_thread).toBe(0);
      expect(row!.parent_channel_id).toBeNull();
      expect(row!.parent_channel_name).toBeNull();
      expect(row!.last_activity_at).toBe(ts);
      expect(JSON.parse(row!.recent_message_ids)).toEqual([msgId]);
      expect(row!.room_name).toBe("general");
      expect(row!.space_name).toBe("Test Space");
      expect(row!.space_avatar).toBe("https://example.com/avatar.png");
    });

    test("creates a row for a thread room with parent channel metadata", () => {
      const db = freshDb();
      seedSpace(db);
      seedChannel(db);
      seedThread(db);

      const ts = 1_717_536_000_000;
      const msgId = ulidForTimestamp(ts);
      upsertActivityItem(db, { roomId: THREAD, spaceId: SPACE, messageId: msgId });

      const row = db
        .query<
          {
            room_id: string;
            is_thread: number;
            parent_channel_id: string | null;
            parent_channel_name: string | null;
            room_name: string | null;
          },
          [string]
        >(
          "select room_id, is_thread, parent_channel_id, parent_channel_name, room_name from activity_item where room_id = ?",
        )
        .get(THREAD);

      expect(row).not.toBeNull();
      expect(row!.is_thread).toBe(1);
      expect(row!.parent_channel_id).toBe(CHANNEL);
      expect(row!.parent_channel_name).toBe("general");
      expect(row!.room_name).toBe("My Thread");
    });

    test("handles missing comp_info gracefully (null names)", () => {
      const db = freshDb();
      seedSpace(db);
      // Channel without comp_info
      db.run("insert into entities (id, stream_id) values (?, ?)", [
        CHANNEL,
        SPACE,
      ]);
      db.run(
        "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
        [CHANNEL],
      );

      const ts = 1_717_536_000_000;
      const msgId = ulidForTimestamp(ts);
      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msgId });

      const row = db
        .query<
          { room_name: string | null; space_name: string | null },
          [string]
        >("select room_name, space_name from activity_item where room_id = ?")
        .get(CHANNEL);

      expect(row!.room_name).toBeNull();
      expect(row!.space_name).toBe("Test Space"); // space comp_info exists
    });
  });

  describe("fast path (subsequent messages)", () => {
    test("prepends new message ID and caps at 5", () => {
      const db = freshDb();
      seedSpace(db);
      seedChannel(db);

      // Insert 6 messages with increasing timestamps.
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const ts = 1_717_536_000_000 + i * 1000;
        const id = ulidForTimestamp(ts);
        ids.push(id);
        upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: id });
      }

      const row = db
        .query<{ recent_message_ids: string }, [string]>(
          "select recent_message_ids from activity_item where room_id = ?",
        )
        .get(CHANNEL);

      const stored: string[] = JSON.parse(row!.recent_message_ids);
      // Should have newest first, capped at 5.
      expect(stored).toHaveLength(5);
      // Most recent (highest timestamp) should be first.
      expect(stored[0]).toBe(ids[5]);
      // Oldest (lowest timestamp) should be dropped.
      expect(stored).not.toContain(ids[0]);
    });

    test("deduplicates if the same message ID is upserted twice", () => {
      const db = freshDb();
      seedSpace(db);
      seedChannel(db);

      const ts = 1_717_536_000_000;
      const msgId = ulidForTimestamp(ts);

      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msgId });
      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msgId });

      const row = db
        .query<{ recent_message_ids: string }, [string]>(
          "select recent_message_ids from activity_item where room_id = ?",
        )
        .get(CHANNEL);

      const stored: string[] = JSON.parse(row!.recent_message_ids);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toBe(msgId);
    });

    test("updates last_activity_at to the newest message timestamp", () => {
      const db = freshDb();
      seedSpace(db);
      seedChannel(db);

      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_100_000;
      const msg1 = ulidForTimestamp(ts1);
      const msg2 = ulidForTimestamp(ts2);

      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msg1 });
      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msg2 });

      const row = db
        .query<{ last_activity_at: number }, [string]>(
          "select last_activity_at from activity_item where room_id = ?",
        )
        .get(CHANNEL);

      expect(row!.last_activity_at).toBe(ts2);
    });
  });

  describe("backfill", () => {
    test("processes events in order without special logic", () => {
      const db = freshDb();
      seedSpace(db);
      seedChannel(db);

      // Simulate backfill: events arrive in monotonically increasing idx order.
      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_000_001;
      const ts3 = 1_717_536_000_002;
      const msg1 = ulidForTimestamp(ts1);
      const msg2 = ulidForTimestamp(ts2);
      const msg3 = ulidForTimestamp(ts3);

      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msg1 });
      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msg2 });
      upsertActivityItem(db, { roomId: CHANNEL, spaceId: SPACE, messageId: msg3 });

      const row = db
        .query<{ recent_message_ids: string; last_activity_at: number }, [string]>(
          "select recent_message_ids, last_activity_at from activity_item where room_id = ?",
        )
        .get(CHANNEL);

      const stored: string[] = JSON.parse(row!.recent_message_ids);
      expect(stored).toHaveLength(3);
      // Newest first.
      expect(stored[0]).toBe(msg3);
      expect(stored[1]).toBe(msg2);
      expect(stored[2]).toBe(msg1);
      expect(row!.last_activity_at).toBe(ts3);
    });
  });

  describe("decodeMessageTimestamp", () => {
    test("returns the same value as ulidx.decodeTime", () => {
      const ts = 1_717_536_000_000;
      const id = ulidForTimestamp(ts);
      expect(decodeMessageTimestamp(id)).toBe(decodeTime(id));
    });
  });
});
