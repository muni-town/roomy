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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { decodeTime } from "ulidx";
import type { StreamDid, Ulid } from "@roomy-space/sdk";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { upsertActivityItem, decodeMessageTimestamp } from "./activityItem.ts";
import type { DbLike } from "../db/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

/** Create a fresh in-memory DB for testing. */
function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [SCHEMA_VERSION]);
  return { db, asyncDb: toAsyncDb(db) };
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
    test("creates a row for a channel room", async () => {
      const { db, asyncDb } = freshDb();
      seedSpace(db);
      seedChannel(db);

      const ts = 1_717_536_000_000;
      const msgId = ulidForTimestamp(ts);
      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msgId as Ulid });

      const row = await asyncDb
        .query("select * from activity_item where room_id = ?")
        .get<{
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
        }>(CHANNEL);

      expect(row).not.toBeNull();
      const r = row!;
      expect(r.room_id).toBe(CHANNEL);
      expect(r.space_id).toBe(SPACE);
      expect(r.is_thread).toBe(0);
      expect(r.parent_channel_id).toBeNull();
      expect(r.parent_channel_name).toBeNull();
      expect(r.last_activity_at).toBe(ts);
      expect(JSON.parse(r.recent_message_ids)).toEqual([msgId]);
      expect(r.room_name).toBe("general");
      expect(r.space_name).toBe("Test Space");
      expect(r.space_avatar).toBe("https://example.com/avatar.png");
    })

    test("creates a row for a thread room with parent channel metadata", async () => {
      const { db, asyncDb } = freshDb();
      seedSpace(db);
      seedChannel(db);
      seedThread(db);

      const ts = 1_717_536_000_000;
      const msgId = ulidForTimestamp(ts);
      await upsertActivityItem(asyncDb, { roomId: THREAD, spaceId: SPACE as StreamDid, messageId: msgId as Ulid });

      const row = await asyncDb
        .query("select room_id, is_thread, parent_channel_id, parent_channel_name, room_name from activity_item where room_id = ?")
        .get<{
          room_id: string;
          is_thread: number;
          parent_channel_id: string | null;
          parent_channel_name: string | null;
          room_name: string | null;
        }>(THREAD);

      expect(row).not.toBeNull();
      const r = row!;
      expect(r.is_thread).toBe(1);
      expect(r.parent_channel_id).toBe(CHANNEL);
      expect(r.parent_channel_name).toBe("general");
      expect(r.room_name).toBe("My Thread");
    })

    test("handles missing comp_info gracefully (null names)", async () => {
      const { db, asyncDb } = freshDb();
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
      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msgId as Ulid });

      const row = await asyncDb
        .query("select room_name, space_name from activity_item where room_id = ?")
        .get<{ room_name: string | null; space_name: string | null }>(CHANNEL);

      expect(row!.room_name).toBeNull();
      expect(row!.space_name).toBe("Test Space"); // space comp_info exists
    })
  });

  describe("fast path (subsequent messages)", () => {
    test("prepends new message ID and caps at 5", async () => {
      const { db, asyncDb } = freshDb();
      seedSpace(db);
      seedChannel(db);

      // Insert 6 messages with increasing timestamps.
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const ts = 1_717_536_000_000 + i * 1000;
        const id = ulidForTimestamp(ts);
        ids.push(id);
        await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: id as Ulid });
      }

      const row = await asyncDb
        .query("select recent_message_ids from activity_item where room_id = ?")
        .get<{ recent_message_ids: string }>(CHANNEL);

      const stored: string[] = JSON.parse(row!.recent_message_ids);
      // Should have newest first, capped at 5.
      expect(stored).toHaveLength(5);
      // Most recent (highest timestamp) should be first.
      expect(stored[0]).toBe(ids[5]);
      // Oldest (lowest timestamp) should be dropped.
      expect(stored).not.toContain(ids[0]);
    })

    test("deduplicates if the same message ID is upserted twice", async () => {
      const { db, asyncDb } = freshDb();
      seedSpace(db);
      seedChannel(db);

      const ts = 1_717_536_000_000;
      const msgId = ulidForTimestamp(ts);

      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msgId as Ulid });
      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msgId as Ulid });

      const row = await asyncDb
        .query("select recent_message_ids from activity_item where room_id = ?")
        .get<{ recent_message_ids: string }>(CHANNEL);

      const stored: string[] = JSON.parse(row!.recent_message_ids);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toBe(msgId);
    })

    test("updates last_activity_at to the newest message timestamp", async () => {
      const { db, asyncDb } = freshDb();
      seedSpace(db);
      seedChannel(db);

      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_100_000;
      const msg1 = ulidForTimestamp(ts1);
      const msg2 = ulidForTimestamp(ts2);

      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msg1 as Ulid });
      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msg2 as Ulid });

      const row = await asyncDb
        .query("select last_activity_at from activity_item where room_id = ?")
        .get<{ last_activity_at: number }>(CHANNEL);

      expect(row!.last_activity_at).toBe(ts2);
    })
  });

  describe("backfill", () => {
    test("processes events in order without special logic", async () => {
      const { db, asyncDb } = freshDb();
      seedSpace(db);
      seedChannel(db);

      // Simulate backfill: events arrive in monotonically increasing idx order.
      const ts1 = 1_717_536_000_000;
      const ts2 = 1_717_536_000_001;
      const ts3 = 1_717_536_000_002;
      const msg1 = ulidForTimestamp(ts1);
      const msg2 = ulidForTimestamp(ts2);
      const msg3 = ulidForTimestamp(ts3);

      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msg1 as Ulid });
      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msg2 as Ulid });
      await upsertActivityItem(asyncDb, { roomId: CHANNEL, spaceId: SPACE as StreamDid, messageId: msg3 as Ulid });

      const row = await asyncDb
        .query("select recent_message_ids, last_activity_at from activity_item where room_id = ?")
        .get<{ recent_message_ids: string; last_activity_at: number }>(CHANNEL);

      const stored: string[] = JSON.parse(row!.recent_message_ids);
      expect(stored).toHaveLength(3);
      // Newest first.
      expect(stored[0]).toBe(msg3);
      expect(stored[1]).toBe(msg2);
      expect(stored[2]).toBe(msg1);
      expect(row!.last_activity_at).toBe(ts3);
    })
  });

  describe("decodeMessageTimestamp", () => {
    test("returns the same value as ulidx.decodeTime", () => {
      const ts = 1_717_536_000_000;
      const id = ulidForTimestamp(ts);
      expect(decodeMessageTimestamp(id)).toBe(decodeTime(id));
    });
  });
});
