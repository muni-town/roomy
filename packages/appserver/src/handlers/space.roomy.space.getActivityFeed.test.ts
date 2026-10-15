/**
 * `space.roomy.space.getActivityFeed` — previews are redacted for every caller,
 * admins included.
 *
 * A message whose author is hidden from the viewer by a block (in either
 * direction) is absent from the feed: the feed shows previews with no indicator
 * and no reveal, so the message is simply not there. Each message's author IS
 * the item's participant, so dropping the message drops the participant too —
 * the item previews the newest surviving message instead.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";

import { closeDb, openDb, openGlobalDb, openSpaceDb } from "../db/db.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import { _resetProfileStoreCache, _setTestGetProfiles } from "../queries/profileStore.ts";
import {
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { getActivityFeedHandler } from "./space.roomy.space.getActivityFeed.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const OTHER = UserDid.assert("did:plc:other");
const SPACE = StreamDid.assert("did:web:space.example");

const BLOCKED_BODY = "a body a block must hide";
const BLOCKED_NAME = "Hidden Author";
const BLOCKED_AVATAR = "https://cdn.example/hidden.png";
const VISIBLE_BODY = "a body anyone may read";
const VISIBLE_NAME = "Visible Author";
const VISIBLE_AVATAR = "https://cdn.example/visible.png";

/** A block record in the shape the PDS fetch produces. */
const block = (subject: string): BlockRecord => ({
  subject,
  source: "roomy",
  createdAt: null,
});

let roomId: string;
let blockedMessageId: string;
let visibleMessageId: string;

beforeEach(async () => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetBlockCaches();
  // Hermetic: no test may reach a real PDS.
  _setTestFetchBlockRecords(async () => []);
  _setTestGetProfiles(async () => []);
  _resetProfileStoreCache();

  roomId = newUlid();
  blockedMessageId = newUlid();
  visibleMessageId = newUlid();

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [OTHER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VIEWER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await space.run("insert into comp_space (entity) values (?)", [SPACE]);
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [roomId],
  );

  for (const [id, author, body] of [
    [blockedMessageId, AUTHOR, BLOCKED_BODY],
    [visibleMessageId, OTHER, VISIBLE_BODY],
  ] as const) {
    await space.run(
      "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
      [id, SPACE, roomId, id],
    );
    await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      id,
      author,
    ]);
    await space.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/plain', ?, ?, ?)",
      [id, Buffer.from(body), id, 1_700_000_000_000],
    );
  }

  // Two messages, newest first: the blocked author's is the newest, so a
  // correct redaction promotes the visible one to the item's preview.
  await space.run(
    `insert into activity_item
       (room_id, space_id, is_thread, last_activity_at, recent_message_ids)
     values (?, ?, 0, ?, ?)`,
    [
      roomId,
      SPACE,
      1_700_000_000_000,
      JSON.stringify([
        { id: blockedMessageId, ts: 2 },
        { id: visibleMessageId, ts: 1 },
      ]),
    ],
  );

  // The global store is authoritative for display names and avatars.
  const global = openGlobalDb();
  await global.run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [AUTHOR, "author.bsky.social", BLOCKED_NAME, BLOCKED_AVATAR, Date.now()],
  );
  await global.run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [OTHER, "other.bsky.social", VISIBLE_NAME, VISIBLE_AVATAR, Date.now()],
  );
});

afterEach(async () => {
  _setTestFetchBlockRecords(null);
  _setTestGetProfiles(null);
  _resetBlockCaches();
  closeDb();
});

/** Give `did` the space admin edge. */
async function makeAdmin(did: UserDid): Promise<void> {
  await openSpaceDb(SPACE).run(
    "insert into edges (head, tail, label) values (?, ?, 'admin')",
    [SPACE, did],
  );
}

/** Read access for a caller without the admin edge. */
async function makeMember(did: UserDid): Promise<void> {
  await openSpaceDb(SPACE).run(
    "insert into edges (head, tail, label) values (?, ?, 'member')",
    [SPACE, did],
  );
}

/** Write `records` into `did`'s stored block set, as the refresh path does. */
async function seedBlockSet(did: UserDid, records: BlockRecord[]): Promise<void> {
  _setTestFetchBlockRecords(async () => records);
  await refreshBlockSet(did);
}

const feed = (did: UserDid = VIEWER) =>
  getActivityFeedHandler({ spaceId: SPACE, limit: "50" }, { did });

describe("getActivityFeed redacts a blocked author", () => {
  test("an ordinary member never sees the blocked message, name or avatar", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const result = await feed();
    const json = JSON.stringify(result);

    expect(json).not.toContain(BLOCKED_BODY);
    expect(json).not.toContain(BLOCKED_NAME);
    expect(json).not.toContain(BLOCKED_AVATAR);
    // Positive control: the non-blocked author survives, unredacted.
    expect(json).toContain(VISIBLE_BODY);
    expect(json).toContain(VISIBLE_NAME);
    expect(json).toContain(VISIBLE_AVATAR);

    // The hidden message is absent, so the item previews the visible one.
    expect(result.feed[0]!.messages.map((m) => m.id)).toEqual([visibleMessageId]);
  });

  test("a space admin who blocked the author sees the same redaction", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const result = await feed();
    const json = JSON.stringify(result);

    expect(json).not.toContain(BLOCKED_BODY);
    expect(json).not.toContain(BLOCKED_NAME);
    expect(json).not.toContain(BLOCKED_AVATAR);
    expect(json).toContain(VISIBLE_BODY);
    expect(json).toContain(VISIBLE_NAME);
    expect(result.feed[0]!.messages.map((m) => m.id)).toEqual([visibleMessageId]);
  });
});
