/**
 * Unread counts and a block.
 *
 * A count is a claim about what is waiting to be read, so it counts only what
 * the reader can see: a hidden author's message is not one of them, in either
 * direction. Every count in the appserver is the same derived range count over
 * `entities`, so the predicate lives in `deriveUnreadCounts` and the callers —
 * the sidebar, the space list, the activity feed, the channel badge, the live
 * `#roomMetadataDiff` delta — all inherit it.
 *
 * The position `updateSeen` writes is a related claim: the newest *visible*
 * message, since anchoring past a hidden row would mark as seen content the
 * reader still has above it.
 *
 * These drive the real handler and the real count against real DBs, because the
 * property under test is the arithmetic, not the wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";

import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import { deriveUnreadCounts, spaceHasUnreads } from "../queries/readPositions.ts";
import {
  _blockRefreshesInFlight,
  _resetBlockCaches,
  hiddenBy,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { setFlagGlobal } from "../queries/featureFlags.ts";
import { updateSeenHandler } from "../handlers/space.roomy.room.updateSeen.ts";

const SPACE = StreamDid.assert("did:web:space.example");
const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const CAROL = UserDid.assert("did:plc:carol");

/** A block record in the shape the PDS fetch produces. */
const block = (subject: string): BlockRecord => ({
  subject,
  source: "roomy",
  createdAt: null,
});

let roomId: string;
/** The hidden author's message — the older of the two. */
let hiddenMsg: string;
/** An ordinary message by someone else, newer. */
let visibleMsg: string;

beforeEach(async () => {
  closeDb();
  const db = openDb({ path: ":memory:" });
  _resetBlockCaches();
  // The block feature is off by default; these tests are about its enforcement.
  await setFlagGlobal(openReadStateDb(), "user-blocks", true);
  _setTestFetchBlockRecords(async () => []);

  roomId = newUlid();
  hiddenMsg = newUlid();
  visibleMsg = newUlid();

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VIEWER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await space.run(
    "insert into comp_room (entity, label) values (?, 'space.roomy.channel')",
    [roomId],
  );
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [hiddenMsg, SPACE, roomId, "a"],
  );
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [visibleMsg, SPACE, roomId, "b"],
  );
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    hiddenMsg,
    AUTHOR,
  ]);
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    visibleMsg,
    VIEWER,
  ]);

  await db.global!().run(
    "insert into entity_space (entity_id, space_did) values (?, ?)",
    [roomId, SPACE],
  );
});

afterEach(async () => {
  await Promise.all(_blockRefreshesInFlight());
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  closeDb();
});

/** Write `records` into `did`'s stored block set, as the PDS refresh path does. */
async function seedBlocks(did: UserDid, records: BlockRecord[]): Promise<void> {
  _setTestFetchBlockRecords(async () => records);
  await refreshBlockSet(did);
  await Promise.all(_blockRefreshesInFlight());
  _setTestFetchBlockRecords(async () => []);
}

/** The count a read derives for `viewerDid` from a watermark of `seenUpTo`. */
async function unread(viewerDid: UserDid, seenUpTo = "0"): Promise<number> {
  const [n] = await deriveUnreadCounts(openSpaceDb(SPACE), [
    { roomId, seenUpTo, hidden: await hiddenBy(viewerDid) },
  ]);
  return n!;
}

const viewerReads = (body: { roomId: string; seenUpTo?: string }) =>
  updateSeenHandler({}, { did: VIEWER }, body);

describe("unread counts and a block", () => {
  test("a reader who hides nobody counts both messages", async () => {
    expect(await unread(VIEWER)).toBe(2);
  });

  test("a hidden author's message is not counted for the viewer who blocked them", async () => {
    await seedBlocks(VIEWER, [block(AUTHOR)]);

    // Only the viewer's own newer message is left to read.
    expect(await unread(VIEWER)).toBe(1);
  });

  test("the reverse direction is not counted either", async () => {
    // The author blocked the viewer. The viewer placed no block, so only the
    // recovered reverse set can answer this — which is the point of the union.
    await seedBlocks(AUTHOR, [block(VIEWER)]);

    expect((await hiddenBy(VIEWER)).has(AUTHOR)).toBe(true);
    expect(await unread(VIEWER)).toBe(1);
  });

  test("a room whose only unread rows are hidden counts zero, and the space reads drained", async () => {
    await seedBlocks(VIEWER, [block(AUTHOR)]);
    // The viewer's own message is the only one they can see, and they have read
    // it — so the hidden one above it is the whole of the remaining difference
    // and it does not count.
    expect(await unread(VIEWER, "b")).toBe(0);

    // Move their own message out of the picture: a watermark before both rows
    // leaves exactly the hidden message outstanding.
    expect(await unread(VIEWER, "0")).toBe(1);

    // The space list answers the same question, and answers it the same way:
    // with the hidden message the only candidate, the space has nothing unread.
    const spaceUnread = await spaceHasUnreads(
      openReadStateDb(),
      openSpaceDb(SPACE),
      VIEWER,
      SPACE,
    );
    expect(spaceUnread).toBe(false);
  });

  test("marking the room read anchors the watermark on the newest visible message", async () => {
    await seedBlocks(VIEWER, [block(AUTHOR)]);

    // No explicit watermark: the handler picks the room's newest message. The
    // newest row overall is the viewer's own, so this asserts nothing about a
    // hidden tail — see the next test for that.
    await viewerReads({ roomId });
    const written = await openReadStateDb()
      .query("select seen_up_to from read_positions where user_did = ? and room_id = ?")
      .get<{ seen_up_to: string }>(VIEWER, roomId);
    expect(written?.seen_up_to).toBe("b");
    expect(await unread(VIEWER, written!.seen_up_to)).toBe(0);
  });

  test("the anchor skips a hidden message at the newest position", async () => {
    // Put the hidden author's message last, so the naive `max(sort_idx)` would
    // jump over content the viewer still has to read.
    await openSpaceDb(SPACE).run("update entities set sort_idx = 'c' where id = ?", [hiddenMsg]);
    await openSpaceDb(SPACE).run("update entities set sort_idx = 'b' where id = ?", [visibleMsg]);
    await seedBlocks(VIEWER, [block(AUTHOR)]);

    await viewerReads({ roomId });

    const written = await openReadStateDb()
      .query("select seen_up_to from read_positions where user_did = ? and room_id = ?")
      .get<{ seen_up_to: string }>(VIEWER, roomId);
    // The newest message the viewer can see, not the newest message.
    expect(written?.seen_up_to).toBe("b");
    expect(await unread(VIEWER, written!.seen_up_to)).toBe(0);
  });

  test("a reader with no block set is unaffected by someone else's blocks", async () => {
    // The author blocked the viewer. A third reader holds no block and is named
    // by none, so both messages are still waiting for them.
    await seedBlocks(AUTHOR, [block(VIEWER)]);

    expect((await hiddenBy(CAROL)).size).toBe(0);
    expect(await unread(CAROL)).toBe(2);
    // And the block is direction-blind for the party who wrote it: the author
    // stops counting the blocked account's message too.
    expect(await unread(AUTHOR)).toBe(1);
  });
});
