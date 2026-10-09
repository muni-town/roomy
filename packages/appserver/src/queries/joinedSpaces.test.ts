import { afterEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";
import { ulid } from "ulidx";
import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { selectJoinedSpaces } from "./joinedSpaces.ts";
import { spaceHasUnreads } from "./readPositions.ts";
import { setUserSpaceMembership } from "./userSpaceMembership.ts";

const USER = UserDid.assert("did:plc:test-user");
const SPACE = StreamDid.assert("did:web:space-stream.example");

/**
 * Set up the worker-backed DBs for the fan-out read path:
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

  test("stored space_order rows override the default updated_at order", async () => {
    const { mainDb } = setup();
    const SPACE_B = StreamDid.assert("did:web:space-b.example");
    const SPACE_C = StreamDid.assert("did:web:space-c.example");

    // Seed three fully materialised spaces with membership intent. Join
    // times are staggered so the default order (updated_at desc) is
    // C, B, A.
    for (const [i, space] of [SPACE, SPACE_B, SPACE_C].entries()) {
      const db = openSpaceDb(space);
      await seedEntity(space, space);
      await seedEntity(space, USER);
      await db.run("insert into comp_info (entity, name) values (?, ?)", [
        space,
        `Space ${i}`,
      ]);
      await db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
        space,
        USER,
      ]);
      await setUserSpaceMembership(
        openReadStateDb(),
        USER,
        space,
        "joined",
        "test",
        `01TEST000000000000000000000${i}`,
      );
    }

    // Default order: most recently joined first.
    const before = await selectJoinedSpaces(mainDb, USER);
    expect(before.map((s) => s.id)).toEqual([SPACE_C, SPACE_B, SPACE]);

    // Store an explicit order: A, C, B.
    await mainDb.run(
      "insert into space_order (user_did, space_did, position) values (?, ?, ?)",
      [USER, SPACE, 0],
    );
    await mainDb.run(
      "insert into space_order (user_did, space_did, position) values (?, ?, ?)",
      [USER, SPACE_C, 1],
    );
    await mainDb.run(
      "insert into space_order (user_did, space_did, position) values (?, ?, ?)",
      [USER, SPACE_B, 2],
    );

    const after = await selectJoinedSpaces(mainDb, USER);
    expect(after.map((s) => s.id)).toEqual([SPACE, SPACE_C, SPACE_B]);
  });

  test("spaces without a stored position sort after ordered ones", async () => {
    const { mainDb } = setup();
    const SPACE_B = StreamDid.assert("did:web:space-b.example");

    for (const [i, space] of [SPACE, SPACE_B].entries()) {
      const db = openSpaceDb(space);
      await seedEntity(space, space);
      await seedEntity(space, USER);
      await db.run("insert into comp_info (entity, name) values (?, ?)", [
        space,
        `Space ${i}`,
      ]);
      await db.run("insert into edges (head, tail, label) values (?, ?, 'member')", [
        space,
        USER,
      ]);
      await setUserSpaceMembership(
        openReadStateDb(),
        USER,
        space,
        "joined",
        "test",
        `01TEST000000000000000000000${i}`,
      );
    }

    // Only SPACE_B has an explicit position; SPACE (joined later) has none
    // and must sort after the ordered one.
    await mainDb.run(
      "insert into space_order (user_did, space_did, position) values (?, ?, ?)",
      [USER, SPACE_B, 0],
    );

    const spaces = await selectJoinedSpaces(mainDb, USER);
    expect(spaces.map((s) => s.id)).toEqual([SPACE_B, SPACE]);
  });
});

describe("spaceHasUnreads", () => {
  test("spaceHasUnreads counts engaged threads belonging to the space only", async () => {
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
    for (const [t, space] of [[t1, SPACE], [t2, SPACE], [tOther, OTHER]] as const) {
      await rs.run(
        "insert into user_thread_activity (user_did, thread_id, space_did, last_active_at) values (?, ?, ?, ?)",
        [USER, t, space, Date.now()],
      );
    }

    // Unread is the difference between a read position and a room's message
    // set, so the counts are made of both: t1 has 3 messages past its
    // position, t2 is read up to its last one, and tOther's 5 live in another
    // space.
    const keys = [
      "01HF7YAT00Z8SA759H2SDDCH32",
      "01HF7YATZ8WP5D8EG2QDZPWCNW",
      "01HF7YAVYGAPZA41KB05BTJR1F",
    ];
    for (const k of keys) {
      await spaceDb.run(
        "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
        [ulid(), SPACE, t1, k],
      );
    }
    for (const k of keys) {
      await otherDb.run(
        "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
        [ulid(), OTHER, tOther, k],
      );
    }
    await rs.run(
      "insert into read_positions (user_did, room_id, space_did, seen_up_to) values (?, ?, ?, '')",
      [USER, t1, SPACE],
    );
    await rs.run(
      "insert into read_positions (user_did, room_id, space_did, seen_up_to) values (?, ?, ?, ?)",
      [USER, t2, SPACE, keys[2]],
    );
    await rs.run(
      "insert into read_positions (user_did, room_id, space_did, seen_up_to) values (?, ?, ?, '')",
      [USER, tOther, OTHER],
    );

    // Only t1 (3 unread) belongs to this space; tOther is excluded — even
    // though it has unreads, it is not one of this space's rooms.
    expect(await spaceHasUnreads(rs, spaceDb, USER, SPACE)).toBe(true);

    // Reading t1 up to its newest message drains the space: the position is
    // the only fact, so moving it past the messages is what marks them read.
    await rs.run(
      "update read_positions set seen_up_to = ? where user_did = ? and room_id = ?",
      [keys[2], USER, t1],
    );
    expect(await spaceHasUnreads(rs, spaceDb, USER, SPACE)).toBe(false);
  });
});

afterEach(() => {
  closeDb();
});
