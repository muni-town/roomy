/**
 * `room.getLinks` / `space.getLinks` and blocked authors.
 *
 * A link row names the message that shared it, so a blocked author's shared
 * URLs must not surface in the links tab. The redaction is the same for every
 * caller — a space admin who blocked the author sees no more than an ordinary
 * member (there is no reveal on these surfaces).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openGlobalDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import {
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { setFlagGlobal } from "../queries/featureFlags.ts";
import { getRoomLinksHandler } from "./space.roomy.room.getLinks.ts";
import { getSpaceLinksHandler } from "./space.roomy.space.getLinks.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const VISIBLE_AUTHOR = UserDid.assert("did:plc:visible");
const SPACE = StreamDid.assert("did:web:space.example");

const ROOM = "room-1";
const BLOCKED_URL = "https://blocked.example/secret";
const VISIBLE_URL = "https://visible.example/ok";
const BLOCKED_TITLE = "Blocked Link Card";
const VISIBLE_TITLE = "Visible Link Card";
const AUTHOR_NAME = "Hidden Author";
const AUTHOR_AVATAR = "https://cdn.example/hidden-avatar.png";

beforeEach(async () => {
  closeDb();
  openDb({ path: ":memory:" });
  // The block feature is off by default; these tests are about its enforcement.
  await setFlagGlobal(openReadStateDb(), "user-blocks", true);
  _resetBlockCaches();
  // Hermetic: no test may reach a real PDS.
  _setTestFetchBlockRecords(async () => []);

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  // `edges` carries FKs onto `entities`, so every DID and room must exist
  // before an author/member edge can name it.
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VIEWER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VISIBLE_AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [ROOM, SPACE]);

  // The room's owning space, so `openSpaceDbForEntity` resolves `room.getLinks`.
  await openGlobalDb().run(
    "insert into entity_space (entity_id, space_did) values (?, ?)",
    [ROOM, SPACE],
  );

  await openGlobalDb().run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [AUTHOR, "author.bsky.social", AUTHOR_NAME, AUTHOR_AVATAR, Date.now()],
  );
  await openGlobalDb().run(
    "insert into profiles (did, handle, name, avatar, updated_at) values (?, ?, ?, ?, ?)",
    [VISIBLE_AUTHOR, "visible.bsky.social", "Visible Author", "https://cdn.example/visible-avatar.png", Date.now()],
  );
});

afterEach(async () => {
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  closeDb();
});

/** Give `did` the space admin edge — clause 2 of the access gate. */
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

/** Write `subjects` into `did`'s stored block set, as the refresh path does. */
async function seedBlockSet(did: UserDid, subjects: string[]): Promise<void> {
  _setTestFetchBlockRecords(async (): Promise<BlockRecord[]> =>
    subjects.map((subject) => ({ subject, source: "roomy", createdAt: null })));
  await refreshBlockSet(did);
}

/**
 * Seed a message in `ROOM` carrying a link, mirroring the materializer: the
 * link entity's `room` is the message id (not the room id) and its stream_id
 * is `''`.
 */
async function seedLink(opts: {
  msgId: string;
  url: string;
  authorDid: UserDid;
  sortIdx: string;
}): Promise<void> {
  const space = openSpaceDb(SPACE);
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [opts.msgId, SPACE, ROOM, opts.sortIdx],
  );
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    opts.msgId,
    opts.authorDid,
  ]);
  await space.run("insert into entities (id, stream_id, room) values (?, '', ?)", [
    opts.url,
    opts.msgId,
  ]);
  await space.run("insert into comp_embed_link (entity, show_preview) values (?, 1)", [
    opts.url,
  ]);
  await openGlobalDb().run(
    "insert into entity_space (entity_id, space_did) values (?, ?)",
    [opts.msgId, SPACE],
  );
}

/** Write the global `link_embeds` card for `url`. */
async function seedEmbed(url: string, title: string): Promise<void> {
  await openGlobalDb().run(
    "insert into link_embeds (url, embed_json) values (?, ?)",
    [url, JSON.stringify({ t: title })],
  );
}

/** The blocked author's link plus a non-blocked author's link. */
async function seedBlockedAndVisible(): Promise<void> {
  await seedLink({ msgId: "msg-blocked", url: BLOCKED_URL, authorDid: AUTHOR, sortIdx: "01B" });
  await seedLink({ msgId: "msg-visible", url: VISIBLE_URL, authorDid: VISIBLE_AUTHOR, sortIdx: "01A" });
  await seedEmbed(BLOCKED_URL, BLOCKED_TITLE);
  await seedEmbed(VISIBLE_URL, VISIBLE_TITLE);
}

/** No trace of the blocked link, its card, or the author's identity. */
function expectNoBlockedTrace(result: unknown): void {
  const json = JSON.stringify(result);
  expect(json).not.toContain(BLOCKED_URL);
  expect(json).not.toContain(BLOCKED_TITLE);
  expect(json).not.toContain(AUTHOR_NAME);
  expect(json).not.toContain(AUTHOR_AVATAR);
}

describe("getLinks hides blocked authors", () => {
  test("room.getLinks omits a blocked author's row for an ordinary member", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedBlockedAndVisible();

    const result = await getRoomLinksHandler({ roomId: ROOM }, { did: VIEWER });
    expect(result.links.map((l) => l.url)).toEqual([VISIBLE_URL]);
    expectNoBlockedTrace(result);
    // Positive control: the non-blocked author's link is present and enriched.
    expect(JSON.stringify(result)).toContain(VISIBLE_TITLE);
  });

  test("room.getLinks omits a blocked author's row for a space admin too", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedBlockedAndVisible();

    const result = await getRoomLinksHandler({ roomId: ROOM }, { did: VIEWER });
    expect(result.links.map((l) => l.url)).toEqual([VISIBLE_URL]);
    expectNoBlockedTrace(result);
    expect(JSON.stringify(result)).toContain(VISIBLE_TITLE);
  });

  test("space.getLinks omits a blocked author's row for an ordinary member", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedBlockedAndVisible();

    const result = await getSpaceLinksHandler({ spaceId: SPACE }, { did: VIEWER });
    expect(result.links.map((l) => l.url)).toEqual([VISIBLE_URL]);
    expectNoBlockedTrace(result);
    expect(JSON.stringify(result)).toContain(VISIBLE_TITLE);
  });

  test("space.getLinks omits a blocked author's row for a space admin too", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedBlockedAndVisible();

    const result = await getSpaceLinksHandler({ spaceId: SPACE }, { did: VIEWER });
    expect(result.links.map((l) => l.url)).toEqual([VISIBLE_URL]);
    expectNoBlockedTrace(result);
    expect(JSON.stringify(result)).toContain(VISIBLE_TITLE);
  });

  test("room.getLinks still advances the cursor when a page's only row was filtered out", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    // Newest row belongs to the blocked author, so the first page displays
    // nothing — but its cursor must still move past it.
    await seedLink({ msgId: "msg-c", url: "https://c.example/blocked", authorDid: AUTHOR, sortIdx: "01C" });
    await seedLink({ msgId: "msg-b", url: "https://b.example/ok", authorDid: VISIBLE_AUTHOR, sortIdx: "01B" });
    await seedLink({ msgId: "msg-a", url: "https://a.example/ok", authorDid: VISIBLE_AUTHOR, sortIdx: "01A" });

    const page1 = await getRoomLinksHandler({ roomId: ROOM, limit: "1" }, { did: VIEWER });
    expect(page1.links).toEqual([]);
    expect(page1.cursor).toBe("01C::https://c.example/blocked");

    const page2 = await getRoomLinksHandler(
      { roomId: ROOM, limit: "1", cursor: page1.cursor! },
      { did: VIEWER },
    );
    expect(page2.links.map((l) => l.url)).toEqual(["https://b.example/ok"]);
  });

  test("space.getLinks still advances the cursor when a page's only row was filtered out", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    await seedLink({ msgId: "msg-c", url: "https://c.example/blocked", authorDid: AUTHOR, sortIdx: "01C" });
    await seedLink({ msgId: "msg-b", url: "https://b.example/ok", authorDid: VISIBLE_AUTHOR, sortIdx: "01B" });
    await seedLink({ msgId: "msg-a", url: "https://a.example/ok", authorDid: VISIBLE_AUTHOR, sortIdx: "01A" });

    const page1 = await getSpaceLinksHandler({ spaceId: SPACE, limit: "1" }, { did: VIEWER });
    expect(page1.links).toEqual([]);
    expect(page1.cursor).toBe("01C::https://c.example/blocked");

    const page2 = await getSpaceLinksHandler(
      { spaceId: SPACE, limit: "1", cursor: page1.cursor! },
      { did: VIEWER },
    );
    expect(page2.links.map((l) => l.url)).toEqual(["https://b.example/ok"]);
  });
});
