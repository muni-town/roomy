/**
 * Board previews and participants (`latestMessage`, `latestMembers`) and
 * blocked authors.
 *
 * The `room_activity` projection is reader-independent, so redaction happens at
 * read time, after a page is assembled and before profiles are layered on. The
 * redaction is the same for every caller — a space admin who blocked the author
 * sees no more than an ordinary member (there is no reveal on these surfaces).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openGlobalDb, openSpaceDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import { _resetProfileStoreCache } from "./profileStore.ts";
import {
  _resetBlockCaches,
  hiddenBy,
  refreshBlockSet,
} from "./userBlocks.ts";
import { fetchRoomActivity, listThreadActivity, type ThreadActivity } from "./threadActivity.ts";
import {
  readRoomActivityProjection,
  rebuildRoomActivity,
} from "./roomActivityProjection.ts";
import { getSpaceThreadsHandler } from "../handlers/space.roomy.space.getThreads.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const VISIBLE = UserDid.assert("did:plc:visible");
const SPACE = StreamDid.assert("did:web:space.example");

const CHANNEL = "01CHANNEL00000000000000000";
const THREAD = "01THREADA000000000000000000".slice(0, 26);

const AUTHOR_MSG = "01MSGA0000000000000000000".slice(0, 26);
const VISIBLE_MSG = "01MSGV0000000000000000000".slice(0, 26);
const AUTHOR_BODY = "blocked author's body text";
const VISIBLE_BODY = "visible author's body text";
const AUTHOR_NAME = "Hidden Author";
const AUTHOR_AVATAR = "https://cdn.example/hidden-avatar.png";
const VISIBLE_NAME = "Visible Author";
const VISIBLE_AVATAR = "https://cdn.example/visible-avatar.png";

beforeEach(async () => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetBlockCaches();
  _resetProfileStoreCache();
  // Hermetic: no test may reach a real PDS.
  _setTestFetchBlockRecords(async () => []);

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into comp_space (entity) values (?)", [SPACE]);
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

  // The per-space names/avatars, which the scan and the projection both read
  // before the global store is layered over them.
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

/** A message authored by `did` at `ts`, plus its `activity_item` sort row. */
async function postMessage(
  id: string,
  did: UserDid,
  ts: number,
  content: string,
): Promise<void> {
  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    id,
    SPACE,
    THREAD,
  ]);
  await space.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
    [id, Buffer.from(content), id, ts],
  );
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [id, did]);
  await space.run(
    `insert into activity_item (room_id, space_id, is_thread, last_activity_at, recent_message_ids)
       values (?, ?, 1, ?, ?)
       on conflict(room_id) do update set
         last_activity_at = excluded.last_activity_at,
         recent_message_ids = excluded.recent_message_ids`,
    [THREAD, SPACE, ts, JSON.stringify([{ id, ts }])],
  );
}

/** `VISIBLE` speaks first; the blocked `AUTHOR` owns the newest message. */
async function seedThread(): Promise<void> {
  await postMessage(VISIBLE_MSG, VISIBLE, 1000, VISIBLE_BODY);
  await postMessage(AUTHOR_MSG, AUTHOR, 2000, AUTHOR_BODY);
}

/**
 * The same DB with `room_activity` made unreadable, so `fetchRoomActivity`
 * takes its live scan — the fallback for a page the projection cannot answer.
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

/** No trace of the blocked message body or the author's identity. */
function expectNoBlockedTrace(result: unknown): void {
  const json = JSON.stringify(result);
  expect(json).not.toContain(AUTHOR_BODY);
  expect(json).not.toContain(AUTHOR_NAME);
  expect(json).not.toContain(AUTHOR_AVATAR);
}

/** One row: the tombstone preview plus the participant list without the author. */
function expectThreadRedacted(row: ThreadActivity): void {
  expect(row.latestTimestamp).toBe(new Date(2000).toISOString());
  expect(row.latestMessage).not.toBeNull();
  expect(row.latestMessage!.id).toBe(AUTHOR_MSG);
  expect(row.latestMessage!.content).toBe("");
  expect(row.latestMessage!.author.did).toBe(AUTHOR);
  expect(row.latestMessage!.author.name).toBeNull();
  expect(row.latestMessage!.author.avatar).toBeNull();
  expect(row.latestMembers.map((m) => m.did)).toEqual([VISIBLE]);
  expectNoBlockedTrace(row);
}

describe("thread activity redacts blocked authors", () => {
  test("without a block the newest author's preview and name are present", async () => {
    await seedThread();

    const { threads } = await listThreadActivity(openSpaceDb(SPACE), {
      kind: "space",
      spaceId: SPACE,
    });
    const row = threads.find((t) => t.id === THREAD)!;

    // Positive control: the fixture really does surface the author a block
    // would otherwise hide, so an empty response cannot pass the redaction
    // assertions below.
    expect(row.latestMessage!.content).toBe(AUTHOR_BODY);
    expect(row.latestMessage!.author.name).toBe(AUTHOR_NAME);
    expect(row.latestMembers.map((m) => m.did)).toEqual([AUTHOR, VISIBLE]);
  });

  test("listThreadActivity redacts the projected page for a blocked viewer", async () => {
    await seedThread();
    await seedBlockSet(VIEWER, [AUTHOR]);
    // Project the page first, so this read is served from `room_activity`.
    await rebuildRoomActivity(openSpaceDb(SPACE), [THREAD]);
    expect(await readRoomActivityProjection(openSpaceDb(SPACE), [THREAD])).not.toBeNull();

    const { threads } = await listThreadActivity(
      openSpaceDb(SPACE),
      { kind: "space", spaceId: SPACE },
      50,
      null,
      null,
      { viewerDid: VIEWER },
    );
    expectThreadRedacted(threads.find((t) => t.id === THREAD)!);
  });

  test("listThreadActivity redacts the scanned page for a blocked viewer", async () => {
    await seedThread();
    await seedBlockSet(VIEWER, [AUTHOR]);

    const { threads } = await listThreadActivity(
      noProjectionDb(openSpaceDb(SPACE)),
      { kind: "space", spaceId: SPACE },
      50,
      null,
      null,
      { viewerDid: VIEWER },
    );
    expectThreadRedacted(threads.find((t) => t.id === THREAD)!);
  });

  test("fetchRoomActivity redacts the projected page", async () => {
    await seedThread();
    await seedBlockSet(VIEWER, [AUTHOR]);
    await rebuildRoomActivity(openSpaceDb(SPACE), [THREAD]);
    expect(await readRoomActivityProjection(openSpaceDb(SPACE), [THREAD])).not.toBeNull();

    const out = await fetchRoomActivity(openSpaceDb(SPACE), [THREAD], await hiddenBy(VIEWER));
    expectThreadRedacted(out.get(THREAD)!);
  });

  test("fetchRoomActivity redacts the scanned page", async () => {
    await seedThread();
    await seedBlockSet(VIEWER, [AUTHOR]);

    const out = await fetchRoomActivity(
      noProjectionDb(openSpaceDb(SPACE)),
      [THREAD],
      await hiddenBy(VIEWER),
    );
    expectThreadRedacted(out.get(THREAD)!);
  });
});

describe("space.getThreads redacts blocked authors", () => {
  test("an ordinary member never sees the blocked preview, name or avatar", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedThread();

    const result = await getSpaceThreadsHandler({ spaceId: SPACE }, { did: VIEWER });
    const room = result.rooms.find((r) => r.id === THREAD)!;

    expect(room).toBeDefined();
    expect(room.activity.latestTimestamp).toBe(new Date(2000).toISOString());
    expect(room.activity.latestMessage!.content).toBe("");
    expect(room.activity.latestMessage!.author.name).toBeNull();
    expect(room.activity.latestMessage!.author.avatar).toBeNull();
    expect(room.activity.latestMembers.map((m) => m.did)).toEqual([VISIBLE]);
    expectNoBlockedTrace(result);
    // Positive control: the non-blocked participant survives, unredacted.
    expect(JSON.stringify(result)).toContain(VISIBLE_NAME);
    expect(JSON.stringify(result)).toContain(VISIBLE_AVATAR);
  });

  test("a space admin who blocked the author sees the exact same redaction", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedThread();

    const result = await getSpaceThreadsHandler({ spaceId: SPACE }, { did: VIEWER });
    const room = result.rooms.find((r) => r.id === THREAD)!;

    expect(room).toBeDefined();
    expect(room.activity.latestMessage!.content).toBe("");
    expect(room.activity.latestMessage!.author.name).toBeNull();
    expect(room.activity.latestMessage!.author.avatar).toBeNull();
    expect(room.activity.latestMembers.map((m) => m.did)).toEqual([VISIBLE]);
    expectNoBlockedTrace(result);
    expect(JSON.stringify(result)).toContain(VISIBLE_NAME);
  });
});
