/**
 * `message.getMessage` — the one route that can open a tombstone.
 *
 * A blocked author's message is redacted on every read path, admin or not.
 * Here, and only here, a caller who placed the block *themselves* and holds the
 * admin edge on the space that materialised the room may read it in full. Every
 * other shape of caller gets the tombstone the timeline would have served —
 * including an admin the author blocked, and including the same admin asking
 * through `room.getMessages`.
 *
 * The gate reads `blocks(viewerDid)`, the viewer's own written set, not
 * `hiddenBy(viewerDid)`: being blocked grants nothing. `isAdmin(db, spaceId,
 * did)` is the per-space admin EDGE, not the process-wide service allowlist —
 * a check written against the wrong one would let every allowlisted identity
 * unmask every block it holds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";

import {
  closeDb,
  openDb,
  openGlobalDb,
  openReadStateDb,
  openSpaceDb,
} from "../db/db.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import {
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { setFlagGlobal } from "../queries/featureFlags.ts";
import { getMessageHandler } from "./space.roomy.message.getMessage.ts";
import { getMessagesHandler } from "./space.roomy.room.getMessages.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const SPACE = StreamDid.assert("did:web:space.example");

/** A block record in the shape the PDS fetch produces. */
const block = (subject: string, source: "roomy" | "bluesky" = "roomy"): BlockRecord => ({
  subject,
  source,
  createdAt: null,
});

let roomId: string;
let messageId: string;
/** An image embed on the message: a reveal has to carry it, a tombstone not. */
let imageEntity: string;

beforeEach(async () => {
  closeDb();
  const db = openDb({ path: ":memory:" });
  // The block feature is off by default; these tests are about its enforcement.
  await setFlagGlobal(openReadStateDb(), "user-blocks", true);
  _resetBlockCaches();
  // Hermetic: no test may reach a real PDS.
  _setTestFetchBlockRecords(async () => []);

  roomId = newUlid();
  messageId = newUlid();
  imageEntity = newUlid();

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  // `edges` carries FKs onto `entities`, so both DIDs have to exist before any
  // author, member or admin edge can name them.
  await space.run("insert into entities (id, stream_id) values (?, ?)", [AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VIEWER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [roomId, SPACE]);
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [messageId, SPACE, roomId, "a"],
  );
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    messageId,
    AUTHOR,
  ]);
  await space.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
    [messageId, Buffer.from("a body only a reveal should return"), messageId, 1_700_000_000_000],
  );
  // An attachment, so "the DTO carries reactions, media and link embeds" is a
  // statement about a message that has them.
  await space.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
    imageEntity,
    SPACE,
    messageId,
  ]);
  await space.run(
    "insert into comp_embed_image (entity, mime_type, width, height, alt) values (?, 'image/png', 4, 4, 'a picture')",
    [imageEntity],
  );

  // The room's owning space, so `openSpaceDbForEntity` resolves it.
  await db.global!().run("insert into entity_space (entity_id, space_did) values (?, ?)", [
    roomId,
    SPACE,
  ]);
  await db.global!().run("insert into entity_space (entity_id, space_did) values (?, ?)", [
    messageId,
    SPACE,
  ]);

  // A display name on the global store: a reveal must carry it, a tombstone
  // must not.
  await openGlobalDb().run(
    "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
    [AUTHOR, "author.bsky.social", "Hidden Author", Date.now()],
  );
});

afterEach(async () => {
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  closeDb();
});

/** Give `did` the space admin edge — the gate's clause 2. */
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

/**
 * Write `records` into `did`'s stored block set and stamp the fetch, exactly as
 * the PDS refresh path does. The stub stays installed for the rest of the test
 * so a background refetch cannot reach the network — and cannot silently clear
 * the set this test just seeded.
 */
async function seedBlockSet(did: UserDid, records: BlockRecord[]): Promise<void> {
  _setTestFetchBlockRecords(async () => records);
  await refreshBlockSet(did);
}

const getMessage = (did: UserDid = VIEWER) =>
  getMessageHandler({ messageId }, { did });

describe("getMessage and the admin reveal", () => {
  test("an admin who blocked the author reads the message in full, still marked blocked", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const message = await getMessage();

    expect(message.id).toBe(messageId);
    expect(message.content).toBe("a body only a reveal should return");
    expect(message.authorName).toBe("Hidden Author");
    expect(message.authorHandle).toBe("author.bsky.social");
    // The DTO is the whole message, attachments included.
    expect(message.media.filter((m) => !m.type.startsWith("text/"))).toHaveLength(1);
    // ...and it still says the author is blocked: the viewer asked for this row
    // by id precisely because they had blocked them, and a row that did not say
    // so would be indistinguishable from an ordinary message.
    expect(message.blocked).toBe(true);
  });

  test("a non-admin who blocked the author gets the tombstone", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    const message = await getMessage();

    expect(message.blocked).toBe(true);
    expect(message.content).toBe("");
    expect(message.authorName).toBe("");
    expect(message.authorDid).toBe(AUTHOR);
    expect(message.media).toEqual([]);
    expect(message.reactions).toEqual([]);
    expect(message.linkEmbeds).toEqual([]);
    expect(message.mimeType).toBeUndefined();
    // The identity and the ordering survive, so the row keeps its place.
    expect(message.timestamp).toBeTruthy();
    expect(message.sort_idx).toBe("a");
  });

  test("an admin the author blocked gets the tombstone — being blocked grants nothing", async () => {
    await makeAdmin(VIEWER);
    // The author wrote the block, and it names the viewer. The viewer placed no
    // block of their own, so `blocks(viewerDid)` is empty and clause 1 fails.
    await seedBlockSet(AUTHOR, [block(VIEWER)]);

    const message = await getMessage();

    expect(message.blocked).toBe(true);
    expect(message.content).toBe("");
    expect(message.authorName).toBe("");
  });

  test("an admin with no block in either direction gets the message unchanged", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, []);

    const message = await getMessage();

    // Nothing hides this author, so this is not a reveal and not a tombstone:
    // the gate never runs, and the row is the ordinary one.
    expect(message.blocked).toBeUndefined();
    expect(message.content).toBe("a body only a reveal should return");
    expect(message.authorName).toBe("Hidden Author");
    expect(message.media.filter((m) => !m.type.startsWith("text/"))).toHaveLength(1);
  });

  test("a block that came from Bluesky opens the tombstone on the same terms", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR, "bluesky")]);

    const message = await getMessage();

    // §3.6's clause 1 is `authorDid ∈ blocks(viewerDid)`, and `blocks` is the
    // union of the two collections: the Bluesky bootstrap exists so a block
    // placed elsewhere is not a second-class one, and §4.4 requires the client
    // — which learns the viewer's set from the same union — never to offer an
    // affordance the server would refuse.
    expect(message.content).toBe("a body only a reveal should return");
    expect(message.blocked).toBe(true);
  });

  test("an admin hidden by a Bluesky-sourced block naming them gets the tombstone", async () => {
    await makeAdmin(VIEWER);
    // The only record naming the viewer is in the author's repo, and it came
    // from the Bluesky collection. The viewer wrote nothing, so clause 1 fails
    // however the other side's block was sourced.
    await seedBlockSet(AUTHOR, [block(VIEWER, "bluesky")]);

    const message = await getMessage();

    expect(message.blocked).toBe(true);
    expect(message.content).toBe("");
    expect(message.authorName).toBe("");
  });

  test("room.getMessages still returns the tombstone to that same admin", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    // The one fetched by id is readable...
    expect((await getMessage()).content).toBe("a body only a reveal should return");

    // ...and the room page is not: the reveal is a route, not a mode.
    const page = await getMessagesHandler({ roomId, limit: "50" }, { did: VIEWER });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.blocked).toBe(true);
    expect(page.messages[0]!.content).toBe("");
    expect(page.messages[0]!.authorName).toBe("");
  });

  test("the reveal writes nothing", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [block(AUTHOR)]);

    /** Row counts for every table, across all three DBs. */
    const census = async (): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const [name, db] of [
        ["readstate", openReadStateDb()],
        ["space", openSpaceDb(SPACE)],
        ["global", openGlobalDb()],
      ] as const) {
        const rows = await db
          .query(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
          )
          .all<{ name: string }>();
        for (const { name: table } of rows) {
          const row = await db
            .query(`select count(*) as n from "${table}"`)
            .get<{ n: number }>();
          counts[`${name}.${table}`] = row?.n ?? 0;
        }
      }
      return counts;
    };

    // Warm every read-path side effect that is not the reveal — the room's
    // access projection is written on the way through `requireRoomRead`, for
    // every caller, revealing or not — so what the census below sees is the
    // reveal's own footprint and nothing else.
    expect((await getMessage()).content).toBe("a body only a reveal should return");

    const before = await census();
    expect((await getMessage()).content).toBe("a body only a reveal should return");
    expect(await census()).toEqual(before);
  });
});
