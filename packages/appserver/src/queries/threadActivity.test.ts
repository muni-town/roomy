import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { listThreadActivity, fetchRoomActivity } from "./threadActivity.ts";
import {
  readRoomActivityProjection,
  rebuildRoomActivity,
} from "./roomActivityProjection.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");
const SCHEMA_VERSION = "10-appserver.4";

function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  db.run("insert into roomy_schema_version (id, version) values (1, ?)", [
    SCHEMA_VERSION,
  ]);
  return { db, asyncDb: toAsyncDb(db) };
}

const SPACE = "did:web:space.example";
const CHANNEL = "01CHANNEL00000000000000000";
const OTHER_CHANNEL = "01CHANNEL11111111111111111";
const THREAD_A = "01THREADA000000000000000000".slice(0, 26);
const THREAD_B = "01THREADB000000000000000000".slice(0, 26);
const THREAD_C = "01THREADC000000000000000000".slice(0, 26);
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CAROL = "did:plc:carol";
const DAVE = "did:plc:dave";

function seed(db: Database) {
  db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  db.run("insert into comp_space (entity) values (?)", [SPACE]);

  for (const ch of [CHANNEL, OTHER_CHANNEL]) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [ch, SPACE]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [ch],
    );
  }

  const threadParents: Array<[string, string]> = [
    [THREAD_A, CHANNEL],
    [THREAD_B, CHANNEL],
    [THREAD_C, OTHER_CHANNEL],
  ];
  for (const [tid, parent] of threadParents) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [tid, SPACE]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
      [tid],
    );
    db.run(
      `insert into edges (head, tail, label, payload)
         values (?, ?, 'link', json_object('canonical_parent', 1))`,
      [parent, tid],
    );
    db.run("insert into comp_info (entity, name) values (?, ?)", [
      tid,
      `Thread ${tid.slice(8, 9)}`,
    ]);
  }

  for (const did of [ALICE, BOB, CAROL, DAVE]) {
    db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      did,
      did,
    ]);
    db.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
      did,
      did.split(":")[2] ?? did,
      null,
    ]);
  }
}

let messageCounter = 0;
function postMessage(
  db: Database,
  threadId: string,
  authorDid: string,
  ts: number,
  content?: string,
): string {
  const msgId = `01MSG${String(messageCounter++).padStart(20, "0")}`;
  db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    msgId,
    SPACE,
    threadId,
  ]);
  db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
    [msgId, Buffer.from(content ?? ""), msgId, ts],
  );
  db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    msgId,
    authorDid,
  ]);
  // Upsert activity_item so the paginated query can sort by last_activity_at.
  const existing = db.query("select 1 from activity_item where room_id = ?").get(threadId);
  if (existing) {
    db.run(
      `update activity_item set last_activity_at = ?, updated_at = (unixepoch() * 1000) where room_id = ?`,
      [ts, threadId],
    );
  } else {
    db.run(
      `insert into activity_item (room_id, space_id, is_thread, last_activity_at, recent_message_ids, created_at, updated_at)
       values (?, ?, 1, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))`,
      [threadId, SPACE, ts, JSON.stringify([msgId])],
    );
  }
  return msgId;
}

let forwardCounter = 0;
/**
 * Forward an existing message (by id) into `threadId`. Mirrors the
 * `space.roomy.msg.forwardMessages.v0` materialiser: creates a
 * forward-reference entity (id = the forward event's ULID) in the target
 * thread with NO comp_content/author of its own, plus a `forward` edge back
 * to the original.
 */
function forwardMessage(db: Database, threadId: string, origMsgId: string) {
  const fwdId = `01FWD${String(forwardCounter++).padStart(20, "0")}`;
  // Forward-reference entity in the target thread.
  db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    fwdId,
    SPACE,
    threadId,
  ]);
  // forward edge: head = forward reference, tail = original message.
  db.run(
    "insert into edges (head, tail, label) values (?, ?, 'forward')",
    [fwdId, origMsgId],
  );
  // Upsert activity_item so the paginated query can sort by last_activity_at.
  // Use the original message's timestamp from comp_content.
  const origTs = db
    .query<{ timestamp: number }, [string]>("select timestamp from comp_content where entity = ?")
    .get(origMsgId) as { timestamp: number } | undefined;
  const ts = origTs?.timestamp ?? Date.now();
  const existing = db.query("select 1 from activity_item where room_id = ?").get(threadId);
  if (existing) {
    db.run(
      `update activity_item set last_activity_at = ?, updated_at = (unixepoch() * 1000) where room_id = ?`,
      [ts, threadId],
    );
  } else {
    db.run(
      `insert into activity_item (room_id, space_id, is_thread, last_activity_at, recent_message_ids, created_at, updated_at)
       values (?, ?, 1, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))`,
      [threadId, SPACE, ts, JSON.stringify([fwdId])],
    );
  }
}

describe("threadActivity", () => {
  test("space scope returns all threads in space, sorted by most recent activity", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 3000); // most recent
    postMessage(db, THREAD_C, CAROL, 2000);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    expect(result.map((t) => t.id)).toEqual([THREAD_B, THREAD_C, THREAD_A]);
    expect(result[0]!.latestTimestamp).toBe(new Date(3000).toISOString());
    // Default kinds is threads-only — every row must be a thread.
    expect(result.every((t) => t.kind === "thread")).toBe(true);
  });

  test("space scope with kinds including channels returns channels + threads", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // Channel activity: messages in CHANNEL (ts 1000) and OTHER_CHANNEL (ts 4000).
    postMessage(db, CHANNEL, ALICE, 1000, "hello in channel");
    postMessage(db, OTHER_CHANNEL, BOB, 4000, "newer channel msg");
    postMessage(db, THREAD_A, CAROL, 2000);
    postMessage(db, THREAD_B, DAVE, 3000);

    const { threads: result } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      50,
      null,
      null,
      { kinds: ["thread", "channel"] },
    );

    // Newest first: OTHER_CHANNEL(4000), THREAD_B(3000), THREAD_A(2000),
    // CHANNEL(1000), then THREAD_C (no activity, sort key 0).
    expect(result.map((t) => t.id)).toEqual([OTHER_CHANNEL, THREAD_B, THREAD_A, CHANNEL, THREAD_C]);
    const channel = result.find((t) => t.id === CHANNEL)!;
    expect(channel.kind).toBe("channel");
    expect(channel.latestTimestamp).toBe(new Date(1000).toISOString());
    expect(channel.latestMessage!.content).toBe("hello in channel");
    const threadB = result.find((t) => t.id === THREAD_B)!;
    expect(threadB.kind).toBe("thread");
    // Channels have no canonical parent.
    expect(channel.canonicalParent).toBeNull();
  });

  test("channel scope stays threads-only even when kinds include channels", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, CHANNEL, ALICE, 1000, "channel msg");
    postMessage(db, THREAD_A, BOB, 2000);
    postMessage(db, THREAD_B, CAROL, 3000);

    const { threads: result } = await listThreadActivity(
      asyncDb,
      { kind: "channel", channelId: CHANNEL },
      50,
      null,
      null,
      { kinds: ["thread", "channel"] },
    );
    expect(result.map((t) => t.id)).toEqual([THREAD_B, THREAD_A]);
    expect(result.every((t) => t.kind === "thread")).toBe(true);
  });

  test("channel scope filters to threads canonically linked from that channel", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 2000);
    postMessage(db, THREAD_C, CAROL, 3000); // in OTHER_CHANNEL

    const { threads: result } = await listThreadActivity(asyncDb, {
      kind: "channel",
      channelId: CHANNEL,
    })
    expect(result.map((t) => t.id).sort()).toEqual([THREAD_A, THREAD_B].sort());
  });

  test("up to 3 unique recent participants, ordered by most recent first", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // Alice oldest, Bob middle, Carol most recent, Dave even more recent.
    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_A, BOB, 2000);
    postMessage(db, THREAD_A, CAROL, 3000);
    postMessage(db, THREAD_A, DAVE, 4000);
    // Carol speaks again — should not be deduplicated to oldest, should keep
    // her latest timestamp.
    postMessage(db, THREAD_A, CAROL, 5000);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadA = result.find((t) => t.id === THREAD_A)!;

    // Most recent 3 distinct: carol(5000), dave(4000), bob(2000). Alice drops.
    expect(threadA.latestMembers.map((m) => m.did)).toEqual([CAROL, DAVE, BOB]);
  });

  test("threads with no messages have null latestTimestamp and empty members", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadA = result.find((t) => t.id === THREAD_A)!;

    expect(threadA.latestTimestamp).toBeNull();
    expect(threadA.latestMembers).toEqual([]);
  });

  test("canonicalParent reflects the canonical 'link' edge head", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const a = result.find((t) => t.id === THREAD_A)!;
    const c = result.find((t) => t.id === THREAD_C)!;
    expect(a.canonicalParent).toBe(CHANNEL);
    expect(c.canonicalParent).toBe(OTHER_CHANNEL);
  });

  test("latestMessage returns the most recent message with author and content", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000, "Hello from Alice");
    postMessage(db, THREAD_A, BOB, 2000, "Reply from Bob");

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadA = result.find((t) => t.id === THREAD_A)!;

    expect(threadA.latestMessage).not.toBeNull();
    expect(threadA.latestMessage!.content).toBe("Reply from Bob");
    expect(threadA.latestMessage!.author.did).toBe(BOB);
    expect(threadA.latestMessage!.author.name).toBe("bob");
    expect(threadA.latestMessage!.timestamp).toBe(new Date(2000).toISOString());
  });

  test("latestMessage is null for threads with no messages", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadA = result.find((t) => t.id === THREAD_A)!;

    expect(threadA.latestMessage).toBeNull();
  });

  test("content entity with a null timestamp is not surfaced as latestMessage", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // Mirror the real-world fresh-space case: a system message ("x joined the
    // space") whose comp_content row has NO timestamp (join materialiser writes
    // comp_content without the timestamp column). It must not become the
    // room's latestMessage — the wire contract requires a string timestamp.
    const sysId = "01SYS000000000000000000000".slice(0, 26);
    db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      sysId,
      SPACE,
      CHANNEL,
    ]);
    db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [sysId, Buffer.from("Alice joined the space."), sysId],
    );
    db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      sysId,
      ALICE,
    ]);

    const { threads: result } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      50,
      null,
      null,
      { kinds: ["thread", "channel"] },
    );
    const channel = result.find((t) => t.id === CHANNEL)!;
    expect(channel.latestTimestamp).toBeNull();
    expect(channel.latestMessage).toBeNull();
  });

  test("latestMessage content decodes text content correctly", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000, "**bold** and _italic_");

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadA = result.find((t) => t.id === THREAD_A)!;

    expect(threadA.latestMessage).not.toBeNull();
    expect(threadA.latestMessage!.content).toBe("**bold** and _italic_");
  });

  // ── Forwarded messages ─────────────────────────────────────────────────────
  //
  // A thread created by forwarding messages contains only forward-reference
  // entities (no own comp_content / author edge); their content/timestamp/author
  // live on the original message reached via the `forward` edge. These tests
  // guard that listThreadActivity follows that edge so a forward-created
  // thread shows a latest timestamp, recent participants, and a latest message.

  test("forwarded message contributes the original's timestamp to latestTimestamp", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // Alice posts a message in THREAD_A, then it's forwarded into THREAD_B.
    const origId = postMessage(db, THREAD_A, ALICE, 9000, "forwarded hello");
    forwardMessage(db, THREAD_B, origId);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadB = result.find((t) => t.id === THREAD_B)!;
    // THREAD_B has no direct messages — only a forwarded one. The forwarded
    // message's original timestamp (9000) must surface as the thread's latest.
    expect(threadB.latestTimestamp).toBe(new Date(9000).toISOString());
    // THREAD_B (9000) should sort ahead of THREAD_A which has only the same msg
    // at 9000 — tiebroken alphabetically. Ensure THREAD_B isn't buried at the
    // bottom (i.e. it isn't treated as having null activity).
    expect(result.map((t) => t.id)).toContain(THREAD_B);
    const aIdx = result.findIndex((t) => t.id === THREAD_A);
    const bIdx = result.findIndex((t) => t.id === THREAD_B);
    // Same latestTimestamp (9000) → alphabetic tiebreak: "Thread A" < "Thread B".
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  test("forwarded message's original author appears in latestMembers", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // Thread created solely by forwarding Bob's message into it.
    const origId = postMessage(db, THREAD_A, BOB, 5000, "hi from bob");
    forwardMessage(db, THREAD_B, origId);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadB = result.find((t) => t.id === THREAD_B)!;
    expect(threadB.latestMembers.map((m) => m.did)).toContain(BOB);
    expect(threadB.latestMembers.map((m) => m.name)).toContain("bob");
  });

  test("forwarded message is returned as the thread's latestMessage with original content/author", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    const origId = postMessage(db, THREAD_A, CAROL, 7000, "forwarded body");
    forwardMessage(db, THREAD_B, origId);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadB = result.find((t) => t.id === THREAD_B)!;
    expect(threadB.latestMessage).not.toBeNull();
    expect(threadB.latestMessage!.content).toBe("forwarded body");
    expect(threadB.latestMessage!.author.did).toBe(CAROL);
    expect(threadB.latestMessage!.author.name).toBe("carol");
    expect(threadB.latestMessage!.timestamp).toBe(new Date(7000).toISOString());
  });

  test("a forwarded message newer than a direct message wins latestTimestamp/latestMessage", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // Direct message from Alice at 1000, then a forwarded message (orig at
    // 2000) into the same thread.
    postMessage(db, THREAD_A, ALICE, 1000, "direct");
    const origId = postMessage(db, THREAD_B, DAVE, 2000, "forwarded later");
    forwardMessage(db, THREAD_A, origId);

    const { threads: result } = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE })
    const threadA = result.find((t) => t.id === THREAD_A)!;
    expect(threadA.latestTimestamp).toBe(new Date(2000).toISOString());
    expect(threadA.latestMessage!.content).toBe("forwarded later");
    expect(threadA.latestMessage!.author.did).toBe(DAVE);
    // Alice (direct) and Dave (forwarded) both participate.
    expect(threadA.latestMembers.map((m) => m.did).sort()).toEqual(
      [ALICE, DAVE].sort(),
    );
  });

  // ── Pagination ────────────────────────────────────────────────────────────
  //
  // listThreadActivity now supports limit and cursor params. These tests
  // verify cursor-based pagination works correctly.

  test("limit returns at most N threads", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    // 3 threads exist (THREAD_A, THREAD_B, THREAD_C). Limit 2 should return 2.
    const { threads: result, cursor } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      2,
    );
    expect(result).toHaveLength(2);
    expect(cursor).not.toBeNull();
  });

  test("cursor advances to the next page", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // Page 1: limit 2
    const { threads: page1, cursor } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      2,
    );
    expect(page1).toHaveLength(2);
    expect(cursor).not.toBeNull();

    // Page 2: use cursor from page 1
    const { threads: page2, cursor: cursor2 } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      2,
      cursor,
    );
    expect(page2).toHaveLength(1);
    // No more pages.
    expect(cursor2).toBeNull();

    // No overlap between pages.
    const page1Ids = new Set(page1.map((t) => t.id));
    for (const t of page2) {
      expect(page1Ids.has(t.id)).toBe(false);
    }
  });

  test("no cursor returns the first page", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    const { threads: result, cursor } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
    );
    // Default limit is 50, we have 3 threads.
    expect(result).toHaveLength(3);
    // No more pages since 3 < 50.
    expect(cursor).toBeNull();
  });

  // ── Search ───────────────────────────────────────────────────────────────
  //
  // The optional `search` param filters threads by a case-insensitive
  // substring match on the thread name (comp_info.name), applied in SQL so
  // cursor pagination stays correct.

  test("search filters threads by name substring (case-insensitive)", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 2000);
    postMessage(db, THREAD_C, CAROL, 3000);

    // Threads are named "Thread A", "Thread B", "Thread C".
    const { threads: result } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      50,
      null,
      "thread b",
    );
    expect(result.map((t) => t.id)).toEqual([THREAD_B]);
  });

  test("search with no matches returns empty", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    const { threads: result } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      50,
      null,
      "zzz-no-such-thread",
    );
    expect(result).toEqual([]);
  });

  test("empty or whitespace search returns all threads", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 2000);
    postMessage(db, THREAD_C, CAROL, 3000);

    const { threads: result } = await listThreadActivity(
      asyncDb,
      { kind: "space", spaceId: SPACE },
      50,
      null,
      "   ",
    );
    expect(result.map((t) => t.id).sort()).toEqual(
      [THREAD_A, THREAD_B, THREAD_C].sort(),
    );
  });
});

/**
 * `room_activity` read parity.
 *
 * The projection replaces a scan of every message in scope, so the only
 * assertion that matters is that the two produce the SAME board — otherwise the
 * optimisation is a behaviour change. Each test reads the fixture through the
 * scan, then through the projection, and compares.
 *
 * Without this the rest of the suite would not exercise the projected path at
 * all: the projection starts empty, so every read above falls back by design.
 */
describe("room_activity projection parity", () => {
  /** Read every fixture room twice: first by scan, then projected. */
  async function bothWays(db: Database, asyncDb: DbLike, roomIds: string[]) {
    const scanned = await fetchRoomActivity(asyncDb, roomIds);
    await rebuildRoomActivity(asyncDb, roomIds);
    const projected = await fetchRoomActivity(asyncDb, roomIds);
    // The projection must actually have been read — a fallback would make this
    // comparison pass trivially.
    expect(await readRoomActivityProjection(asyncDb, roomIds)).not.toBeNull();
    return { scanned, projected };
  }

  const plain = (m: Map<string, unknown>) =>
    JSON.parse(
      JSON.stringify([...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
    );

  test("matches the scan for threads with messages, empties, and a thread with no messages", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000, "first");
    postMessage(db, THREAD_A, BOB, 3000, "latest");
    postMessage(db, THREAD_A, CAROL, 2000);
    postMessage(db, THREAD_C, DAVE, 4000, "other channel thread");
    // THREAD_B stays empty — no message event can ever maintain its row, so it
    // is the case that forces the warm-on-miss.

    const rooms = [THREAD_A, THREAD_B, THREAD_C];
    const { scanned, projected } = await bothWays(db, asyncDb, rooms);
    expect(plain(projected)).toEqual(plain(scanned));
  });

  test("matches the scan for a legacy forward reference", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    // The original lives in another channel; the forward reference is the only
    // row in THREAD_B, and carries no content or author of its own.
    const original = postMessage(db, OTHER_CHANNEL, ALICE, 5000, "original text");
    forwardMessage(db, THREAD_B, original);

    const rooms = [OTHER_CHANNEL, THREAD_B];
    const { scanned, projected } = await bothWays(db, asyncDb, rooms);
    expect(plain(projected)).toEqual(plain(scanned));
    // And the forwarded original really is what the board shows, not a blank
    // row that happens to match a blank scan.
    expect(projected.get(THREAD_B)!.latestMessage!.content).toBe("original text");
    expect(projected.get(THREAD_B)!.latestMembers.map((m) => m.did)).toEqual([ALICE]);
  });

  test("matches the scan once the latest message is deleted", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    const newest = postMessage(db, THREAD_A, BOB, 3000, "newest");
    postMessage(db, THREAD_A, ALICE, 1000, "older");
    await rebuildRoomActivity(asyncDb, [THREAD_A]);

    // Delete the newest message, as the delete materialiser does (the entity
    // row disappears; `edges` cascades).
    db.run("delete from entities where id = ?", [newest]);
    await rebuildRoomActivity(asyncDb, [THREAD_A]);

    const { scanned, projected } = await bothWays(db, asyncDb, [THREAD_A]);
    expect(plain(projected)).toEqual(plain(scanned));
    expect(projected.get(THREAD_A)!.latestMessage!.content).toBe("older");
    expect(projected.get(THREAD_A)!.latestMembers.map((m) => m.did)).toEqual([ALICE]);
  });

  test("a partially projected page is completed by warming only the missing rooms", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000, "a");
    postMessage(db, THREAD_C, CAROL, 2000, "c");
    // Only one of the two rooms is projected.
    await rebuildRoomActivity(asyncDb, [THREAD_A]);

    // Count the rows each statement returns: the point of the partial warm is
    // that the room WITH a row is never re-read. A scan of the page would
    // return a row per message for both rooms; warming the missing one returns
    // rows for that room only.
    const seen: Array<{ sql: string; rows: number }> = [];
    const counting: DbLike = {
      ...asyncDb,
      query(sql: string) {
        const inner = asyncDb.query(sql);
        return {
          async all<T>(...params: unknown[]): Promise<T[]> {
            const rows = await inner.all<T>(...params);
            seen.push({ sql, rows: rows.length });
            return rows;
          },
          async get<T>(...params: unknown[]): Promise<T | null> {
            const row = await inner.get<T>(...params);
            seen.push({ sql, rows: row == null ? 0 : 1 });
            return row;
          },
        };
      },
    };

    const result = await fetchRoomActivity(counting, [THREAD_A, THREAD_C]);
    expect(result.get(THREAD_A)!.latestMessage!.content).toBe("a");
    expect(result.get(THREAD_C)!.latestMessage!.content).toBe("c");

    // `fetchRoomActivity`'s own scan reports the rooms it reads by returning a
    // row per room; the message-level scan returns one per message. Neither may
    // appear: the page was answered from the projection plus a warm of the one
    // room that had no row.
    const scanLike = seen.filter(
      (s) => /left join comp_content fcc/.test(s.sql) && s.rows > 1,
    );
    expect(scanLike).toEqual([]);

    // The fallback warmed the row it had to read, so the whole page is
    // projected from the next read on — this is what stops a single quiet room
    // from pinning a board to the scan forever.
    expect(await readRoomActivityProjection(asyncDb, [THREAD_A, THREAD_C])).not.toBeNull();
  });

  test("a page the projection cannot answer at all is served by the scan", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    postMessage(db, THREAD_A, ALICE, 1000, "a");

    // No projection table: the one case that still needs the live scan, because
    // there is nowhere to warm to.
    const noProjection = new Database(":memory:");
    noProjection.exec("pragma foreign_keys = on");
    noProjection.exec(
      readFileSync(SCHEMA_PATH, "utf8").replace(
        /create table if not exists room_activity[\s\S]*?\) strict;/,
        "",
      ),
    );
    seed(noProjection);
    postMessage(noProjection, THREAD_A, ALICE, 1000, "a");
    const result = await fetchRoomActivity(toAsyncDb(noProjection), [THREAD_A]);
    expect(result.get(THREAD_A)!.latestMessage!.content).toBe("a");
  });
});


/**
 * The scan's cost over a worker boundary is the payload it structured-clones
 * back, and that payload is what used to scale with the number of messages in
 * scope: SQLite has no `LIMIT` per group, so picking one message per room by
 * reading them all and reducing in JS returned a row per message to keep one
 * per room — measured at 1724 rows to keep 50 on a real space.
 *
 * This pins the shape, not the answer — the `threadActivity` tests above hold
 * the answer. It counts rows returned per statement, so it fails on a
 * per-message shape regardless of how large the message bodies are (the bodies
 * were already moved off the boundary by an earlier split) and regardless of
 * machine speed: 20 messages across 2 rooms must not yield 20 rows anywhere.
 */
test("the scan returns one row per room, not one per message", async () => {
  const { db, asyncDb } = freshDb();
  seed(db);

  const BODY = "x".repeat(4096);
  for (let i = 0; i < 10; i++) postMessage(db, THREAD_A, ALICE, 1000 + i, BODY);
  for (let i = 0; i < 10; i++) postMessage(db, THREAD_C, CAROL, 2000 + i, BODY);

  const seen: Array<{ sql: string; rows: number }> = [];
  const counting: DbLike = {
    ...asyncDb,
    query(sql: string) {
      const inner = asyncDb.query(sql);
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          const rows = await inner.all<T>(...params);
          seen.push({ sql, rows: rows.length });
          return rows;
        },
        async get<T>(...params: unknown[]): Promise<T | null> {
          const row = await inner.get<T>(...params);
          seen.push({ sql, rows: row == null ? 0 : 1 });
          return row;
        },
      };
    },
  };

  const result = await fetchRoomActivity(counting, [THREAD_A, THREAD_C]);
  // Both rooms really were served, so a scan that returned nothing at all
  // cannot satisfy this test.
  expect(result.get(THREAD_A)!.latestMessage!.content).toBe(BODY);
  expect(result.get(THREAD_C)!.latestMessage!.content).toBe(BODY);

  // 20 messages, 2 rooms. A fold that reads every message returns 20 rows;
  // the reduction returns one board row per room plus the authors it renders.
  const widest = Math.max(...seen.map((s) => s.rows));
  expect(widest).toBeLessThan(20);
  const total = seen.reduce((a, s) => a + s.rows, 0);
  expect(total).toBeLessThan(20);
});
