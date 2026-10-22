/**
 * Active-thread participants (`resolveThreadsByIds` → the sidebar's
 * `activeThreads`) and blocked authors.
 *
 * The activity columns come from the reader-independent `room_activity`
 * projection, so redaction happens at read time, before any profile is layered
 * on. The redaction is the same for every caller — a space admin who blocked
 * the author sees no more than an ordinary member (there is no reveal on these
 * surfaces).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openGlobalDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import { _resetProfileStoreCache } from "./profileStore.ts";
import {
  _resetBlockCaches,
  hiddenBy,
  refreshBlockSet,
} from "./userBlocks.ts";
import { setFlagGlobal } from "./featureFlags.ts";
import { resolveThreadsByIds } from "./userActiveThreads.ts";
import { readRoomActivityProjection } from "./roomActivityProjection.ts";
import { getMetadataHandler } from "../handlers/space.roomy.space.getMetadata.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const VISIBLE = UserDid.assert("did:plc:visible");
const SPACE = StreamDid.assert("did:web:space.example");

const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREADA000000000000000000".slice(0, 26);

const AUTHOR_MSG = "01MSGA0000000000000000000".slice(0, 26);
const VISIBLE_MSG = "01MSGV0000000000000000000".slice(0, 26);
const AUTHOR_NAME = "Hidden Author";
const AUTHOR_AVATAR = "https://cdn.example/hidden-avatar.png";
const VISIBLE_NAME = "Visible Author";
const VISIBLE_AVATAR = "https://cdn.example/visible-avatar.png";

beforeEach(async () => {
  closeDb();
  openDb({ path: ":memory:" });
  // The block feature is off by default; these tests are about its enforcement.
  await setFlagGlobal(openReadStateDb(), "user-blocks", true);
  _resetBlockCaches();
  _resetProfileStoreCache();
  // Hermetic: no test may reach a real PDS.
  _setTestFetchBlockRecords(async () => []);

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into comp_space (entity) values (?)", [SPACE]);
  // The global entity→space index is what proves the space exists: getMetadata
  // checks it instead of opening (and creating) the per-space DB.
  await openGlobalDb().run(
    "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
    [SPACE, SPACE],
  );
  // `edges` carries FKs onto `entities`, so every DID and room must exist
  // before an author/member/link edge can name it.
  for (const did of [VIEWER, AUTHOR, VISIBLE]) {
    await space.run("insert into entities (id, stream_id) values (?, ?)", [did, SPACE]);
  }
  await space.run("insert into entities (id, stream_id) values (?, ?)", [CHANNEL, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [CHANNEL],
  );
  await space.run("insert into entities (id, stream_id) values (?, ?)", [THREAD, SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [THREAD],
  );
  await space.run(
    `insert into edges (head, tail, label, payload)
       values (?, ?, 'link', json_object('canonical_parent', 1))`,
    [CHANNEL, THREAD],
  );
  await space.run("insert into comp_info (entity, name) values (?, ?)", [CHANNEL, "Channel"]);
  await space.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
    AUTHOR,
    AUTHOR_NAME,
    AUTHOR_AVATAR,
  ]);
  await space.run("insert into comp_info (entity, name, avatar) values (?, ?, ?)", [
    VISIBLE,
    VISIBLE_NAME,
    VISIBLE_AVATAR,
  ]);

  // Fresh global profiles, so `resolveProfiles` finds them present and starts
  // no network fetch.
  await openGlobalDb().run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [AUTHOR, "author.bsky.social", AUTHOR_NAME, AUTHOR_AVATAR, Date.now()],
  );
  await openGlobalDb().run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [VISIBLE, "visible.bsky.social", VISIBLE_NAME, VISIBLE_AVATAR, Date.now()],
  );

  // The viewer has engaged with the thread, so `space.getMetadata` surfaces it
  // as an active thread in the sidebar.
  await openReadStateDb().run(
    `insert into user_thread_activity (user_did, thread_id, space_did, last_active_at)
       values (?, ?, ?, ?)`,
    [VIEWER, THREAD, SPACE, Date.now()],
  );
});

afterEach(async () => {
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  _resetProfileStoreCache();
  closeDb();
});

/** Give `did` the space member edge — read access without the admin edge. */
async function makeMember(did: UserDid): Promise<void> {
  await openSpaceDb(SPACE).run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [SPACE, did],
  );
}

/** Give `did` the space admin edge. */
async function makeAdmin(did: UserDid): Promise<void> {
  await openSpaceDb(SPACE).run(
    "insert into edges (head, tail, label) values (?, ?, 'admin')",
    [SPACE, did],
  );
}

/** Write `subjects` into `did`'s stored block set, as the refresh path does. */
async function seedBlockSet(did: UserDid, subjects: string[]): Promise<void> {
  _setTestFetchBlockRecords(async (): Promise<BlockRecord[]> =>
    subjects.map((subject) => ({ subject, source: "roomy", createdAt: null })));
  await refreshBlockSet(did);
}

/** A message authored by `did` at `ts` in the thread. */
async function postMessage(
  id: string,
  did: UserDid,
  ts: number,
): Promise<void> {
  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    id,
    SPACE,
    THREAD,
  ]);
  await space.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
    [id, Buffer.from("body"), id, ts],
  );
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, did]);
}

/** `VISIBLE` speaks first; the blocked `AUTHOR` is the newest participant. */
async function seedThread(): Promise<void> {
  await postMessage(VISIBLE_MSG, VISIBLE, 1000);
  await postMessage(AUTHOR_MSG, AUTHOR, 2000);
}

/**
 * The same DB with `room_activity` made unreadable, so `resolveThreadsByIds`
 * takes its scan fallback — the projection is an optimisation, the scan is the
 * behaviour it has to reproduce.
 */
function noProjectionDb(db: DbLike): DbLike {
  return {
    ...db,
    query(sql: string) {
      if (sql.includes("room_activity")) throw new Error("no such table: room_activity");
      return db.query(sql);
    },
  };
}

/** No trace of the blocked participant's name or avatar. */
function expectNoBlockedTrace(result: unknown): void {
  const json = JSON.stringify(result);
  expect(json).not.toContain(AUTHOR_NAME);
  expect(json).not.toContain(AUTHOR_AVATAR);
}

const dids = (r: { latestMembers: Array<{ did: string }> }) =>
  r.latestMembers.map((m) => m.did);

describe("resolveThreadsByIds redacts blocked participants", () => {
  test("without a block the newest participant is present", async () => {
    await seedThread();

    const result = await resolveThreadsByIds(openSpaceDb(SPACE), [THREAD]);
    const entry = result.get(THREAD)!;

    // Positive control: the fixture really does surface the participant a
    // block would otherwise hide.
    expect(dids(entry)).toEqual([AUTHOR, VISIBLE]);
    expect(entry.latestMembers[0]!.name).toBe(AUTHOR_NAME);
  });

  test("the projected read drops the blocked participant", async () => {
    await seedThread();
    await seedBlockSet(VIEWER, [AUTHOR]);
    // Warm the projection first, so this read is served from `room_activity`.
    await resolveThreadsByIds(openSpaceDb(SPACE), [THREAD]);
    expect(await readRoomActivityProjection(openSpaceDb(SPACE), [THREAD])).not.toBeNull();

    const result = await resolveThreadsByIds(
      openSpaceDb(SPACE),
      [THREAD],
      await hiddenBy(VIEWER),
    );
    const entry = result.get(THREAD)!;

    expect(dids(entry)).toEqual([VISIBLE]);
    expect(entry.latestMembers[0]!.name).toBe(VISIBLE_NAME);
    expectNoBlockedTrace(entry);
  });

  test("the scanned read drops the blocked participant", async () => {
    await seedThread();
    await seedBlockSet(VIEWER, [AUTHOR]);

    const result = await resolveThreadsByIds(
      noProjectionDb(openSpaceDb(SPACE)),
      [THREAD],
      await hiddenBy(VIEWER),
    );
    const entry = result.get(THREAD)!;

    expect(dids(entry)).toEqual([VISIBLE]);
    expect(entry.latestMembers[0]!.name).toBe(VISIBLE_NAME);
    expectNoBlockedTrace(entry);
  });
});

describe("space.getMetadata active threads redact blocked participants", () => {
  test("an ordinary member never sees the blocked participant, name or avatar", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedThread();

    const result = await getMetadataHandler({ spaceId: SPACE }, { did: VIEWER });
    const channels = [
      ...result.sidebar.categories.flatMap((c) => c.channels),
      ...result.sidebar.orphans,
    ];
    const thread = channels.flatMap((c) => c.activeThreads ?? []).find((t) => t.id === THREAD);

    expect(thread).toBeDefined();
    expect(thread!.activity.latestMembers.map((m) => m.did)).toEqual([VISIBLE]);
    expectNoBlockedTrace(result);
    // Positive control: the non-blocked participant survives, unredacted.
    expect(JSON.stringify(result)).toContain(VISIBLE_NAME);
    expect(JSON.stringify(result)).toContain(VISIBLE_AVATAR);
  });

  test("a space admin who blocked the author sees the exact same redaction", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedThread();

    const result = await getMetadataHandler({ spaceId: SPACE }, { did: VIEWER });
    const channels = [
      ...result.sidebar.categories.flatMap((c) => c.channels),
      ...result.sidebar.orphans,
    ];
    const thread = channels.flatMap((c) => c.activeThreads ?? []).find((t) => t.id === THREAD);

    expect(thread).toBeDefined();
    expect(thread!.activity.latestMembers.map((m) => m.did)).toEqual([VISIBLE]);
    expectNoBlockedTrace(result);
    expect(JSON.stringify(result)).toContain(VISIBLE_NAME);
  });
});
