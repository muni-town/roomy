import { afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import {
  JOINED_SPACE_LABEL,
  recordPersonalSpaceMembership,
  selectJoinedSpaces,
} from "./joinedSpaces.ts";
import { getSpaceUnreadStats } from "./readPositions.ts";
import { setUserSpaceMembership } from "./userSpaceMembership.ts";

const USER = UserDid.assert("did:plc:test-user");
const SPACE = StreamDid.assert("did:web:space-stream.example");

/**
 * Set up the worker-backed DBs for the Phase 3 fan-out read path:
 *   - space-scoped rows (entities, comp_info, member/admin edges) go into the
 *     per-space DB via `openSpaceDb`
 *   - durable membership intent goes into the read-state DB via
 *     `openReadStateDb` (the handle `selectJoinedSpaces` now takes)
 *
 * Returns `{ mainDb }` where `mainDb` is the read-state handle.
 */
function setup(): { mainDb: DbLike } {
  closeDb();
  openDb({ path: ":memory:" });
  const mainDb = openReadStateDb();
  return { mainDb };
}

/** Seed an entity row in the space's per-space DB. */
async function seedEntity(spaceId: string, id: string, streamId: string = id): Promise<void> {
  const db = openSpaceDb(spaceId);
  await db.run("insert into entities (id, stream_id) values (?, ?)", [id, streamId]);
}

/**
 * Seed the rows the *space stream's* own materialisation produces: the space
 * + user entities, the space's name, and the creator's admin/member edges.
 * This is space-global truth — it says nothing about who has joined.
 */
async function seedSpace(): Promise<void> {
  const db = openSpaceDb(SPACE);
  await seedEntity(SPACE, SPACE);
  await seedEntity(SPACE, USER);
  await db.run("insert into comp_info (entity, name) values (?, ?)", [
    SPACE,
    "Test Space",
  ]);
  await db.run("insert into edges (head, tail, label) values (?, ?, 'admin')", [
    SPACE,
    USER,
  ]);
  await db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
    SPACE,
    USER,
  ]);
}

/** Seed durable membership intent in the read-state DB: `user` joined `space`. */
async function joinIntent(user: string, space: string): Promise<void> {
  await setUserSpaceMembership(
    openReadStateDb(),
    user as UserDid,
    space as StreamDid,
    "joined",
    "test",
    "01TEST0000000000000000000000",
  );
}

describe("selectJoinedSpaces", () => {
  test("a space the user has joined is visible", async () => {
    const { mainDb } = setup();
    await seedSpace();
    await joinIntent(USER, SPACE);

    const spaces = await selectJoinedSpaces(mainDb, USER);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({
      id: SPACE,
      name: "Test Space",
      isMember: true,
      isAdmin: true,
    });
  });

  test("a space with no membership intent is invisible even if it exists", async () => {
    const { mainDb } = setup();
    // Space fully materialised (entity, info, member edge) but the user
    // never joined it — no membership intent.
    await seedSpace();

    expect(await selectJoinedSpaces(mainDb, USER)).toEqual([]);
  });

  test("a space joined by a different user is not visible (multi-user)", async () => {
    const { mainDb } = setup();
    await seedSpace();
    const OTHER_USER = UserDid.assert("did:plc:other-user");
    await seedEntity(SPACE, OTHER_USER);
    // Another user joined the same space. Their intent must not leak into ours.
    await joinIntent(OTHER_USER, SPACE);

    expect(await selectJoinedSpaces(mainDb, USER)).toEqual([]);
  });

  test("a joined space the caller is banned from is excluded", async () => {
    const { mainDb } = setup();
    await seedSpace();
    await joinIntent(USER, SPACE);
    const db = openSpaceDb(SPACE);
    await db.run("insert into comp_bans (entity, user_did) values (?, ?)", [
      SPACE,
      USER,
    ]);

    expect(await selectJoinedSpaces(mainDb, USER)).toEqual([]);
  });

  test("a joined space with no member/admin edge for the caller is excluded", async () => {
    const { mainDb } = setup();
    // Membership intent exists, but the space stream never recorded the
    // member edge (e.g. join not yet accepted) — not a real membership.
    const db = openSpaceDb(SPACE);
    await seedEntity(SPACE, SPACE);
    await seedEntity(SPACE, USER);
    await db.run("insert into comp_info (entity, name) values (?, ?)", [
      SPACE,
      "Test Space",
    ]);
    await joinIntent(USER, SPACE);

    expect(await selectJoinedSpaces(mainDb, USER)).toEqual([]);
  });

  test("a left space is included only with includeLeft", async () => {
    const { mainDb } = setup();
    await seedSpace();
    await setUserSpaceMembership(
      openReadStateDb(),
      USER,
      SPACE,
      "left",
      "test",
      "01TEST0000000000000000000001",
    );

    expect(await selectJoinedSpaces(mainDb, USER)).toEqual([]);
    const left = await selectJoinedSpaces(mainDb, USER, { includeLeft: true });
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: SPACE, isMember: false, isAdmin: false });
  });
});

describe("recordPersonalSpaceMembership", () => {
  test("makes an already-materialised space visible to getSpaces", async () => {
    const { mainDb } = setup();
    await seedSpace();
    expect(await selectJoinedSpaces(mainDb, USER)).toEqual([]);

    // `recordPersonalSpaceMembership` seeds the joinedSpace edge + entity rows
    // in the per-space DB. The read path now reads durable intent from the
    // read-state DB, so we mirror the join there too (as the handler does).
    const spaceDb = openSpaceDb(SPACE);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);
    await joinIntent(USER, SPACE);

    const spaces = await selectJoinedSpaces(mainDb, USER);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ id: SPACE, name: "Test Space" });
  });

  test("seeds the entity rows the joinedSpace edge depends on", async () => {
    const { mainDb } = setup();
    // Neither the space nor the user entity exists yet. The write lands in
    // the per-space DB (which has the `entities` table).
    const spaceDb = openSpaceDb(SPACE);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);

    const edge = await spaceDb
      .query(
        "select head, tail from edges where label = ?",
      )
      .get<{ head: string; tail: string }>(JOINED_SPACE_LABEL);
    expect(edge).toEqual({ head: USER, tail: SPACE });

    // The space entity is scoped to its own stream, not the user.
    const spaceEntity = await spaceDb
      .query(
        "select stream_id from entities where id = ?",
      )
      .get<{ stream_id: string }>(SPACE);
    expect(spaceEntity?.stream_id).toBe(SPACE);
  });

  test("is idempotent", async () => {
    const { mainDb } = setup();
    await seedSpace();

    const spaceDb = openSpaceDb(SPACE);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);
    await recordPersonalSpaceMembership(spaceDb, SPACE, USER);
    await joinIntent(USER, SPACE);

    expect(await selectJoinedSpaces(mainDb, USER)).toHaveLength(1);
  });

  test("getSpaceUnreadStats counts engaged threads belonging to the space only", async () => {
    const { mainDb } = setup();
    const OTHER = StreamDid.assert("did:web:other-space.example");

    // Two threads in this space, one thread in another space.
    const t1 = "thread-in-space-1";
    const t2 = "thread-in-space-2";
    const tOther = "thread-in-other-space";
    const spaceDb = openSpaceDb(SPACE);
    for (const t of [t1, t2]) {
      await spaceDb.run("insert into entities (id, stream_id) values (?, ?)", [t, SPACE]);
    }
    const otherDb = openSpaceDb(OTHER);
    await otherDb.run("insert into entities (id, stream_id) values (?, ?)", [tOther, OTHER]);

    // User engaged with all three threads.
    const rs = openReadStateDb();
    for (const t of [t1, t2, tOther]) {
      await rs.run(
        "insert into user_thread_activity (user_did, thread_id, last_active_at) values (?, ?, ?)",
        [USER, t, Date.now()],
      );
    }

    // Unread counts: t1 has 3 unread, t2 has 0, tOther has 5.
    for (const [t, n] of [[t1, 3], [t2, 0], [tOther, 5]] as const) {
      await rs.run(
        "insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count) values (?, ?, ?, '0', ?)",
        [USER, t, SPACE, n],
      );
    }

    const stats = await getSpaceUnreadStats(rs, spaceDb, USER, SPACE);
    // Only t1 (3 unread) belongs to this space; tOther is excluded.
    expect(stats.unreadCount).toBe(3);
    expect(stats.unreadThreadCount).toBe(1);
  });
});

afterEach(() => {
  closeDb();
});
