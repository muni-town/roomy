/**
 * `space.roomy.message.getReactions` — a blocked reactor is redacted for every
 * caller, admins included.
 *
 * A reactor hidden from the viewer by a block (in either direction) is dropped
 * before any profile is resolved, so their name and avatar never enter the
 * process. An emoji whose every reactor is hidden therefore has no group at
 * all. The emoji count on the message DTO is computed elsewhere and is not
 * this surface's concern.
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
import { getReactionsHandler } from "./space.roomy.message.getReactions.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const OTHER = UserDid.assert("did:plc:other");
const SPACE = StreamDid.assert("did:web:space.example");

const BLOCKED_NAME = "Hidden Author";
const BLOCKED_AVATAR = "https://cdn.example/hidden.png";
const VISIBLE_NAME = "Visible Author";

/** A block record in the shape the PDS fetch produces. */
const block = (subject: string): BlockRecord => ({
  subject,
  source: "roomy",
  createdAt: null,
});

let roomId: string;
let messageId: string;

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
  messageId = newUlid();

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [OTHER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VIEWER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [messageId, SPACE, roomId, messageId],
  );
  await space.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [roomId],
  );

  // `👍` has one visible and one hidden reactor; `🥕` has only the hidden one.
  await space.run(
    `insert into comp_reaction (entity, user, reaction_id, reaction, created_at, updated_at)
     values (?, ?, ?, ?, 0, 0)`,
    [messageId, AUTHOR, newUlid(), "👍"],
  );
  await space.run(
    `insert into comp_reaction (entity, user, reaction_id, reaction, created_at, updated_at)
     values (?, ?, ?, ?, 0, 0)`,
    [messageId, OTHER, newUlid(), "👍"],
  );
  await space.run(
    `insert into comp_reaction (entity, user, reaction_id, reaction, created_at, updated_at)
     values (?, ?, ?, ?, 0, 0)`,
    [messageId, AUTHOR, newUlid(), "🥕"],
  );

  // `openSpaceDbForEntity` routes by the global `entity_space` index.
  const global = openGlobalDb();
  await global.run("insert into entity_space (entity_id, space_did) values (?, ?)", [
    messageId,
    SPACE,
  ]);

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

const reactions = (did: UserDid = VIEWER) =>
  getReactionsHandler({ messageId }, { did });

describe("getReactions redacts a blocked reactor", () => {
  test("an ordinary member never sees the blocked reactor, name or avatar", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const result = await reactions();
    const json = JSON.stringify(result);

    expect(json).not.toContain(BLOCKED_NAME);
    expect(json).not.toContain(BLOCKED_AVATAR);
    expect(json).not.toContain(AUTHOR);

    // An emoji whose every reactor is hidden has no group at all.
    expect(result.reactions.find((g) => g.emoji === "🥕")).toBeUndefined();

    // Positive control: the visible reactor survives, unredacted.
    const thumbs = result.reactions.find((g) => g.emoji === "👍")!;
    expect(thumbs.reactors.map((r) => r.did)).toEqual([OTHER]);
    expect(thumbs.reactors[0]!.name).toBe(VISIBLE_NAME);
  });

  test("a space admin who blocked the reactor sees the same redaction", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const result = await reactions();
    const json = JSON.stringify(result);

    expect(json).not.toContain(BLOCKED_NAME);
    expect(json).not.toContain(BLOCKED_AVATAR);
    expect(json).not.toContain(AUTHOR);

    expect(result.reactions.find((g) => g.emoji === "🥕")).toBeUndefined();

    const thumbs = result.reactions.find((g) => g.emoji === "👍")!;
    expect(thumbs.reactors.map((r) => r.did)).toEqual([OTHER]);
    expect(thumbs.reactors[0]!.name).toBe(VISIBLE_NAME);
  });
});
