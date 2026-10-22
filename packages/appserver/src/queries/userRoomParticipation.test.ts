/**
 * `backfillUserRoomParticipation` parity.
 *
 * The backfill seeds the read-state `user_room_participation` table from the
 * per-space `room_activity` projection. These tests run it against a DB with
 * the projection and against the scan fallback and require the seeded state to
 * be identical — the projection may only change what the backfill costs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import {
  _resetParticipationBackfillCache,
  authorRoomsSql,
  backfillUserRoomParticipation,
  hasUserParticipated,
} from "./userRoomParticipation.ts";

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "schema-space.sql",
);

const SPACE = "did:web:space.example";
const ROOM_A = "01ROOMA0000000000000000000";
const ROOM_B = "01ROOMB0000000000000000000";
const USER = "did:plc:alice";
const OTHER = "did:plc:bob";

function freshDb(): { readState: DbLike; spaceDb: DbLike } {
  closeDb();
  openDb({ path: ":memory:" });
  return { readState: openReadStateDb(), spaceDb: openSpaceDb(SPACE) };
}

async function seed(spaceDb: DbLike): Promise<void> {
  await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await spaceDb.run("insert into comp_space (entity) values (?)", [SPACE]);
  for (const room of [ROOM_A, ROOM_B]) {
    await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [room, SPACE]);
    await spaceDb.run("insert into comp_room (entity, label) values (?, 'space.roomy.channel')", [room]);
  }
  for (const did of [USER, OTHER]) {
    await spaceDb.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  }
}

async function post(
  spaceDb: DbLike,
  id: string,
  room: string,
  did: string,
  ts: number,
): Promise<void> {
  await spaceDb.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [id, SPACE, room]);
  await spaceDb.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
    [id, Buffer.from("hi"), id, ts],
  );
  await spaceDb.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, did]);
}

/** The same DB with `room_activity` unreadable, forcing the scan fallback. */
function noProjectionDb(spaceDb: DbLike): DbLike {
  return {
    ...spaceDb,
    query(sql: string) {
      if (sql.includes("room_activity")) throw new Error("no such table: room_activity");
      return spaceDb.query(sql);
    },
  };
}

describe("backfillUserRoomParticipation", () => {
  test("a user's newest authored message per room is recorded, scanned or projected", async () => {
    const { readState, spaceDb } = freshDb();
    await seed(spaceDb);

    // USER posts twice in ROOM_A (the newer one must win) and never in ROOM_B;
    // OTHER's messages must not create a row for USER.
    await post(spaceDb, "01MSGPART00000000000000001", ROOM_A, USER, 5000);
    await post(spaceDb, "01MSGPART00000000000000002", ROOM_A, USER, 9000);
    await post(spaceDb, "01MSGPART00000000000000003", ROOM_B, OTHER, 7000);

    await backfillUserRoomParticipation(readState, noProjectionDb(spaceDb), USER, SPACE);
    const scanned = await readState
      .query(
        "select room_id, last_message_at from user_room_participation where user_did = ? order by room_id",
      )
      .all<{ room_id: string; last_message_at: number }>(USER);

    const { readState: fresh, spaceDb: freshSpace } = freshDb();
    await seed(freshSpace);
    await post(freshSpace, "01MSGPART00000000000000001", ROOM_A, USER, 5000);
    await post(freshSpace, "01MSGPART00000000000000002", ROOM_A, USER, 9000);
    await post(freshSpace, "01MSGPART00000000000000003", ROOM_B, OTHER, 7000);
    await backfillUserRoomParticipation(fresh, freshSpace, USER, SPACE);
    const projected = await fresh
      .query(
        "select room_id, last_message_at from user_room_participation where user_did = ? order by room_id",
      )
      .all<{ room_id: string; last_message_at: number }>(USER);

    expect(projected).toEqual(scanned);
    expect(scanned).toEqual([{ room_id: ROOM_A, last_message_at: 9000 }]);
  });

  test("a user who has never posted gets no participation", async () => {
    const { readState, spaceDb } = freshDb();
    await seed(spaceDb);
    await post(spaceDb, "01MSGPART00000000000000001", ROOM_A, OTHER, 5000);

    await backfillUserRoomParticipation(readState, spaceDb, USER, SPACE);
    expect(await hasUserParticipated(readState, USER, ROOM_A)).toBe(false);

    await backfillUserRoomParticipation(readState, noProjectionDb(spaceDb), USER, SPACE);
    expect(await hasUserParticipated(readState, USER, ROOM_A)).toBe(false);
  });

  test("a user participating in several rooms is recorded in each", async () => {
    const { readState, spaceDb } = freshDb();
    await seed(spaceDb);
    await post(spaceDb, "01MSGPART00000000000000001", ROOM_A, USER, 1000);
    await post(spaceDb, "01MSGPART00000000000000002", ROOM_B, USER, 2000);

    await backfillUserRoomParticipation(readState, spaceDb, USER, SPACE);
    const rows = await readState
      .query("select room_id from user_room_participation where user_did = ? order by room_id")
      .all<{ room_id: string }>(USER);
    expect(rows.map((r) => r.room_id)).toEqual([ROOM_A, ROOM_B]);
  });
});

describe("authorRooms candidate plan", () => {
  /**
   * The candidate lookup runs once per recipient per space on the push-digest
   * path, over a table where `head` — the join key — is absent from
   * `idx_edges_label_tail`'s key. Production analyzes each space on boot and
   * the planner only reaches that index with statistics to estimate from, so
   * the seed is sized and analyzed the same way: without statistics the plan
   * below is a scan of the `stream_id` partition, and without the index it is a
   * per-edge visit back to `entities`.
   */
  test("the candidate lookup seeks idx_edges_label_tail_head", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));

    // Enough authored edges per user, in enough rooms, that the distinct and
    // the join are over something: 200 users x 5 messages, none of them the
    // user in the assertion's own row set.
    db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
    db.run("insert into entities (id, stream_id) values (?, ?)", [USER, SPACE]);
    const messages: string[] = [];
    const edges: string[] = [];
    for (let a = 0; a < 200; a++) {
      const did = `did:plc:author${a}`;
      db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, SPACE]);
      for (let m = 0; m < 5; m++) {
        const id = `01PARTICIP${String(a * 5 + m).padStart(10, "0")}`;
        messages.push(`('${id}', '${SPACE}', '01ROOM${(a * 5 + m) % 60}')`);
        edges.push(`('${id}', '${did}', 'author')`);
        edges.push(`('${id}', '${did}', 'reply')`);
      }
    }
    db.exec(`insert into entities (id, stream_id, room) values ${messages.join(",")}`);
    db.exec(`insert into edges (head, tail, label) values ${edges.join(",")}`);
    db.exec("analyze");

    const plan = db
      .query<{ detail: string }, []>(`explain query plan ${authorRoomsSql()}`)
      .all()
      .map((r) => r.detail)
      .join(" | ");

    expect(plan).toContain(
      "SEARCH author_e USING COVERING INDEX idx_edges_label_tail_head (label=? AND tail=?)",
    );
  });
});
