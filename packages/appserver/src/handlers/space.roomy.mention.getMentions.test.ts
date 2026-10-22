/**
 * `space.roomy.mention.getMentions` — a mention of a hidden author is
 * redacted for every caller, admins included.
 *
 * The mention stays in the list: the row is the viewer's own notification, so
 * it must not vanish. Its message comes back as the tombstone `selectMessages`
 * builds for a hidden author — empty body, empty author name, no avatar.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";

import { closeDb, openDb, openGlobalDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import { _resetProfileStoreCache, _setTestGetProfiles } from "../queries/profileStore.ts";
import {
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { setFlagGlobal } from "../queries/featureFlags.ts";
import { getMentionsHandler } from "./space.roomy.mention.getMentions.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const OTHER = UserDid.assert("did:plc:other");
const SPACE = StreamDid.assert("did:web:space.example");

const BLOCKED_BODY = "a body a block must hide";
const BLOCKED_NAME = "Hidden Author";
const BLOCKED_AVATAR = "https://cdn.example/hidden.png";
const VISIBLE_BODY = "a body anyone may read";
const VISIBLE_NAME = "Visible Author";

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
  // The block feature is off by default; these tests are about its enforcement.
  await setFlagGlobal(openReadStateDb(), "user-blocks", true);
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
  await space.run("insert into comp_room (entity, label) values (?, 'space.roomy.channel')", [
    roomId,
  ]);

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

  // Two mentions of VIEWER, newest first. The blocked author's message is the
  // newest, so ordering cannot be what hides it.
  const global = openGlobalDb();
  await global.run(
    `insert into mentions (did, message_id, space_did, room_id, kind, created_at)
     values (?, ?, ?, ?, 'mention', ?)`,
    [VIEWER, blockedMessageId, SPACE, roomId, 2],
  );
  await global.run(
    `insert into mentions (did, message_id, space_did, room_id, kind, created_at)
     values (?, ?, ?, ?, 'mention', ?)`,
    [VIEWER, visibleMessageId, SPACE, roomId, 1],
  );

  // The global store is authoritative for display names and avatars.
  await global.run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [AUTHOR, "author.bsky.social", BLOCKED_NAME, BLOCKED_AVATAR, Date.now()],
  );
  await global.run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [OTHER, "other.bsky.social", VISIBLE_NAME, null, Date.now()],
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

const mentions = (did: UserDid = VIEWER) =>
  getMentionsHandler({ did }, { did });

describe("getMentions redacts a blocked author", () => {
  test("an ordinary member sees the blocked mention as an empty tombstone", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const result = await mentions();
    const json = JSON.stringify(result);

    expect(json).not.toContain(BLOCKED_BODY);
    expect(json).not.toContain(BLOCKED_NAME);
    expect(json).not.toContain(BLOCKED_AVATAR);
    // Positive control: the non-blocked mention survives, unredacted.
    expect(json).toContain(VISIBLE_BODY);
    expect(json).toContain(VISIBLE_NAME);

    // The blocked mention is kept — redacted, not dropped.
    const blocked = result.mentions.find((m) => m.message.id === blockedMessageId)!;
    expect(blocked).toBeDefined();
    expect(blocked.message.blocked).toBe(true);
    expect(blocked.message.content).toBe("");
    expect(blocked.message.authorName).toBe("");
    expect(blocked.message.authorAvatar).toBeUndefined();

    const visible = result.mentions.find((m) => m.message.id === visibleMessageId)!;
    expect(visible.message.content).toBe(VISIBLE_BODY);
    expect(visible.message.authorName).toBe(VISIBLE_NAME);
  });

  test("a space admin who blocked the author sees the same redaction", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const result = await mentions();
    const json = JSON.stringify(result);

    expect(json).not.toContain(BLOCKED_BODY);
    expect(json).not.toContain(BLOCKED_NAME);
    expect(json).not.toContain(BLOCKED_AVATAR);
    expect(json).toContain(VISIBLE_BODY);
    expect(json).toContain(VISIBLE_NAME);

    const blocked = result.mentions.find((m) => m.message.id === blockedMessageId)!;
    expect(blocked.message.blocked).toBe(true);
    expect(blocked.message.content).toBe("");
    expect(blocked.message.authorName).toBe("");
    expect(blocked.message.authorAvatar).toBeUndefined();
  });
});
