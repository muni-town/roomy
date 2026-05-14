import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../db/db.ts";
import { listThreadActivity } from "./threadActivity.ts";

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
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
) {
  const msgId = `01MSG${String(messageCounter++).padStart(20, "0")}`;
  db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    msgId,
    SPACE,
    threadId,
  ]);
  db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
    [msgId, Buffer.from(""), msgId, ts],
  );
  db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    msgId,
    authorDid,
  ]);
}

describe("threadActivity", () => {
  test("space scope returns all threads in space, sorted by most recent activity", () => {
    const db = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 3000); // most recent
    postMessage(db, THREAD_C, CAROL, 2000);

    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
    expect(result.map((t) => t.id)).toEqual([THREAD_B, THREAD_C, THREAD_A]);
    expect(result[0]!.latestTimestamp).toBe(new Date(3000).toISOString());
  });

  test("channel scope filters to threads canonically linked from that channel", () => {
    const db = freshDb();
    seed(db);

    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_B, BOB, 2000);
    postMessage(db, THREAD_C, CAROL, 3000); // in OTHER_CHANNEL

    const result = listThreadActivity(db, {
      kind: "channel",
      channelId: CHANNEL,
    });
    expect(result.map((t) => t.id).sort()).toEqual([THREAD_A, THREAD_B].sort());
  });

  test("up to 3 unique recent participants, ordered by most recent first", () => {
    const db = freshDb();
    seed(db);

    // Alice oldest, Bob middle, Carol most recent, Dave even more recent.
    postMessage(db, THREAD_A, ALICE, 1000);
    postMessage(db, THREAD_A, BOB, 2000);
    postMessage(db, THREAD_A, CAROL, 3000);
    postMessage(db, THREAD_A, DAVE, 4000);
    // Carol speaks again — should not be deduplicated to oldest, should keep
    // her latest timestamp.
    postMessage(db, THREAD_A, CAROL, 5000);

    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
    const threadA = result.find((t) => t.id === THREAD_A)!;

    // Most recent 3 distinct: carol(5000), dave(4000), bob(2000). Alice drops.
    expect(threadA.latestMembers.map((m) => m.did)).toEqual([CAROL, DAVE, BOB]);
  });

  test("threads with no messages have null latestTimestamp and empty members", () => {
    const db = freshDb();
    seed(db);

    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
    const threadA = result.find((t) => t.id === THREAD_A)!;

    expect(threadA.latestTimestamp).toBeNull();
    expect(threadA.latestMembers).toEqual([]);
  });

  test("canonicalParent reflects the canonical 'link' edge head", () => {
    const db = freshDb();
    seed(db);
    const result = listThreadActivity(db, { kind: "space", spaceId: SPACE });
    const a = result.find((t) => t.id === THREAD_A)!;
    const c = result.find((t) => t.id === THREAD_C)!;
    expect(a.canonicalParent).toBe(CHANNEL);
    expect(c.canonicalParent).toBe(OTHER_CHANNEL);
  });
});
