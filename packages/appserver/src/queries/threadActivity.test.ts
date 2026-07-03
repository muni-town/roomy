import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import { listThreadActivity } from "./threadActivity.ts";

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
}

describe("threadActivity", () => {
  test("space scope returns all threads in space, sorted by most recent activity", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 3000); // most recent
    postMessage(db, THREAD_C, CAROL, 2000);

    const result = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE });
    expect(result.map((t) => t.id)).toEqual([THREAD_B, THREAD_C, THREAD_A]);
    expect(result[0]!.latestTimestamp).toBe(new Date(3000).toISOString());
  });

  test("channel scope filters to threads canonically linked from that channel", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 2000);
    postMessage(db, THREAD_C, CAROL, 3000); // in OTHER_CHANNEL

    const result = await listThreadActivity(asyncDb, {
      kind: "channel",
      channelId: CHANNEL,
    });
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

    const result = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE });
    const threadA = result.find((t) => t.id === THREAD_A)!;

    // Most recent 3 distinct: carol(5000), dave(4000), bob(2000). Alice drops.
    expect(threadA.latestMembers.map((m) => m.did)).toEqual([CAROL, DAVE, BOB]);
  });

  test("threads with no messages have null latestTimestamp and empty members", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    const result = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE });
    const threadA = result.find((t) => t.id === THREAD_A)!;

    expect(threadA.latestTimestamp).toBeNull();
    expect(threadA.latestMembers).toEqual([]);
  });

  test("canonicalParent reflects the canonical 'link' edge head", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);
    const result = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE });
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

    const result = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE });
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

    const result = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE });
    const threadA = result.find((t) => t.id === THREAD_A)!;

    expect(threadA.latestMessage).toBeNull();
  });

  test("latestMessage content decodes text content correctly", async () => {
    const { db, asyncDb } = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000, "**bold** and _italic_");

    const result = await listThreadActivity(asyncDb, { kind: "space", spaceId: SPACE });
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

  test("forwarded message contributes the original's timestamp to latestTimestamp", () => {
    const db = freshDb();
    seed(db);

    // Alice posts a message in THREAD_A, then it's forwarded into THREAD_B.
    const origId = postMessage(db, THREAD_A, ALICE, 9000, "forwarded hello");
    forwardMessage(db, THREAD_B, origId);

    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
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

  test("forwarded message's original author appears in latestMembers", () => {
    const db = freshDb();
    seed(db);

    // Thread created solely by forwarding Bob's message into it.
    const origId = postMessage(db, THREAD_A, BOB, 5000, "hi from bob");
    forwardMessage(db, THREAD_B, origId);

    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
    const threadB = result.find((t) => t.id === THREAD_B)!;
    expect(threadB.latestMembers.map((m) => m.did)).toContain(BOB);
    expect(threadB.latestMembers.map((m) => m.name)).toContain("bob");
  });

  test("forwarded message is returned as the thread's latestMessage with original content/author", () => {
    const db = freshDb();
    seed(db);

    const origId = postMessage(db, THREAD_A, CAROL, 7000, "forwarded body");
    forwardMessage(db, THREAD_B, origId);

    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
    const threadB = result.find((t) => t.id === THREAD_B)!;
    expect(threadB.latestMessage).not.toBeNull();
    expect(threadB.latestMessage!.content).toBe("forwarded body");
    expect(threadB.latestMessage!.author.did).toBe(CAROL);
    expect(threadB.latestMessage!.author.name).toBe("carol");
    expect(threadB.latestMessage!.timestamp).toBe(new Date(7000).toISOString());
  });

  test("a forwarded message newer than a direct message wins latestTimestamp/latestMessage", () => {
    const db = freshDb();
    seed(db);

    // Direct message from Alice at 1000, then a forwarded message (orig at
    // 2000) into the same thread.
    postMessage(db, THREAD_A, ALICE, 1000, "direct");
    const origId = postMessage(db, THREAD_B, DAVE, 2000, "forwarded later");
    forwardMessage(db, THREAD_A, origId);

    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
    const threadA = result.find((t) => t.id === THREAD_A)!;
    expect(threadA.latestTimestamp).toBe(new Date(2000).toISOString());
    expect(threadA.latestMessage!.content).toBe("forwarded later");
    expect(threadA.latestMessage!.author.did).toBe(DAVE);
    // Alice (direct) and Dave (forwarded) both participate.
    expect(threadA.latestMembers.map((m) => m.did).sort()).toEqual(
      [ALICE, DAVE].sort(),
    );
  });
});
