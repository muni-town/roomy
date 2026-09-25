/**
 * `room_access` projection maintenance contract.
 *
 * The one behaviour here that is a HARD requirement rather than an
 * optimisation: **rematerialisation must not populate projections**. Replay
 * deletes the affected rows instead of writing them, so a replayed structural
 * change cannot leave a stale row behind while the projection stays empty of
 * backfilled data.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toAsyncDb } from "../db/syncAdapter.ts";
import type { DbLike } from "../db/types.ts";
import {
  affectedRoomIds,
  maintainRoomAccess,
  readRoomAccessProjection,
} from "./roomAccessProjection.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "db", "schema.sql");

const SPACE = "did:web:projection.example";
const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREAD000000000000000000";

function freshDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return toAsyncDb(db);
}

async function seed(db: DbLike): Promise<void> {
  await db.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  // Entities before the edges that reference them (FKs are on).
  await db.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  await db.run("insert into entities (id, stream_id) values (?, ?)", [THREAD, SPACE]);
  await db.run("insert into comp_room (entity, label) values (?, 'space.roomy.channel')", [CHANNEL]);
  await db.run("insert into comp_room (entity, label) values (?, 'space.roomy.thread')", [THREAD]);
  await db.run(
    `insert into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD],
  );
}

describe("room_access projection maintenance", () => {
  test("a live room event upserts the row with its parent link", async () => {
    const db = freshDb();
    await seed(db);

    // createRoomLink carries no room ids in the table, so it re-derives the
    // whole space — the same path the synthetic spaceMeta event takes.
    const step = maintainRoomAccess(
      { $type: "space.roomy.link.createRoomLink.v0" },
      SPACE,
      false,
    );
    expect(step).not.toBeNull();
    await db.run(step!.sql, ...step!.params);

    const thread = await readRoomAccessProjection(db, THREAD);
    expect(thread).toEqual({
      room_id: THREAD,
      space_id: SPACE,
      parent_channel_id: CHANNEL,
    });
    expect((await readRoomAccessProjection(db, CHANNEL))!.parent_channel_id).toBeNull();
  });

  test("the same event during backfill DELETES rather than populates", async () => {
    const db = freshDb();
    await seed(db);

    // Warm the projection first, so there is a row that a replay could stale.
    const live = maintainRoomAccess(
      { $type: "space.roomy.link.createRoomLink.v0" },
      SPACE,
      false,
    )!;
    await db.run(live.sql, ...live.params);
    expect(await readRoomAccessProjection(db, THREAD)).not.toBeNull();

    // Replay the same event. It must INVALIDATE, not re-populate: no
    // projection data may be produced by rematerialisation.
    const replay = maintainRoomAccess(
      { $type: "space.roomy.link.createRoomLink.v0" },
      SPACE,
      true,
    )!;
    await db.run(replay.sql, ...replay.params);

    expect(await readRoomAccessProjection(db, THREAD)).toBeNull();
    expect(await readRoomAccessProjection(db, CHANNEL)).toBeNull();
  });

  test("events that cannot affect the projection produce no step", () => {
    for (const $type of [
      "space.roomy.message.createMessage.v0",
      "space.roomy.space.joinSpace.v0",
      "space.roomy.role.addMemberRole.v0",
    ]) {
      expect(maintainRoomAccess({ $type }, SPACE, false)).toBeNull();
      expect(maintainRoomAccess({ $type }, SPACE, true)).toBeNull();
    }
  });

  test("affectedRoomIds reports nothing for unknown or malformed events", () => {
    expect(affectedRoomIds({ $type: "space.roomy.unknown.v0" })).toEqual([]);
    expect(affectedRoomIds({})).toEqual([]);
    // The spaceMeta tree case is the "recompute from the DB" sentinel.
    expect(affectedRoomIds({ $type: "space.roomy.query.spaceMeta.v0" })).toBeNull();
  });
});
