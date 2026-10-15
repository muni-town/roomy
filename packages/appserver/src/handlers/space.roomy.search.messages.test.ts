/**
 * `search.messages` and blocked authors.
 *
 * Search hits are hydrated through `selectMessages`, which resolves the
 * viewer's hidden-authors set itself, so a blocked author's hit must come back
 * as a tombstone — no body, no display name, no avatar — for every caller. A
 * space admin gets no reveal here (the reveal belongs to `message.getMessage`
 * alone). A reply attachment whose target is authored by a blocked author is
 * redacted on the same terms.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openGlobalDb, openSpaceDb } from "../db/db.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import {
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import {
  _resetQdrantClient,
  _setQdrantClientForTest,
  type QdrantClientLike,
} from "../search/qdrantSearch.ts";
import { searchMessagesHandler } from "./space.roomy.search.messages.ts";

const VIEWER = UserDid.assert("did:plc:viewer");
const AUTHOR = UserDid.assert("did:plc:author");
const VISIBLE_AUTHOR = UserDid.assert("did:plc:visible");
const SPACE = StreamDid.assert("did:web:space.example");
const ROOM = "room-1";

const MSG_BLOCKED = "msg-blocked";
const MSG_VISIBLE = "msg-visible";
const MSG_REPLY = "msg-reply";
const MSG_REPLY_TARGET = "msg-reply-target";

const BLOCKED_BODY = "a blocked body that must not leak";
const REPLY_TARGET_BODY = "a blocked reply body";
const VISIBLE_BODY = "a visible body";
const REPLY_BODY = "a visible reply";

const AUTHOR_NAME = "Hidden Author";
const AUTHOR_AVATAR = "https://cdn.example/hidden-avatar.png";

/**
 * Minimal Qdrant double: returns the points it was constructed with, ignoring
 * the filter — the handler's read-access post-filter is what the test probes.
 */
class FakeQdrant implements QdrantClientLike {
  constructor(
    private readonly points: Array<{
      id: string;
      score: number;
      payload: Record<string, unknown>;
    }>,
  ) {}

  async collectionExists(): Promise<{ exists: boolean }> {
    return { exists: true };
  }
  async createCollection(): Promise<unknown> {
    return {};
  }
  async createPayloadIndex(): Promise<unknown> {
    return {};
  }
  async upsert(): Promise<unknown> {
    return {};
  }
  async delete(): Promise<unknown> {
    return {};
  }
  async query(): Promise<{
    points: Array<{ id: unknown; score: number; payload?: Record<string, unknown> | null }>;
  }> {
    return { points: this.points };
  }
  async count(): Promise<{ count: number }> {
    return { count: this.points.length };
  }
}

beforeEach(async () => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetBlockCaches();
  // Hermetic: no test may reach a real PDS.
  _setTestFetchBlockRecords(async () => []);

  const space = openSpaceDb(SPACE);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [SPACE, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VIEWER, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [VISIBLE_AUTHOR, SPACE]);
  await space.run("insert into entities (id, stream_id) values (?, ?)", [ROOM, SPACE]);

  await seedMessage({ msgId: MSG_BLOCKED, authorDid: AUTHOR, body: BLOCKED_BODY });
  await seedMessage({ msgId: MSG_VISIBLE, authorDid: VISIBLE_AUTHOR, body: VISIBLE_BODY });
  await seedMessage({ msgId: MSG_REPLY_TARGET, authorDid: AUTHOR, body: REPLY_TARGET_BODY });
  await seedMessage({
    msgId: MSG_REPLY,
    authorDid: VISIBLE_AUTHOR,
    body: REPLY_BODY,
    replyTo: MSG_REPLY_TARGET,
  });

  // Both hit message ids and the reply target, so `openSpaceDbForEntity`
  // resolves the room they live in.
  for (const id of [MSG_BLOCKED, MSG_VISIBLE, MSG_REPLY, MSG_REPLY_TARGET]) {
    await openGlobalDb().run(
      "insert into entity_space (entity_id, space_did) values (?, ?)",
      [id, SPACE],
    );
  }

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
  _resetQdrantClient();
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

/** Seed a message row with an author edge and (optionally) a reply edge. */
async function seedMessage(opts: {
  msgId: string;
  authorDid: UserDid;
  body: string;
  replyTo?: string;
}): Promise<void> {
  const space = openSpaceDb(SPACE);
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [opts.msgId, SPACE, ROOM, opts.msgId],
  );
  await space.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    opts.msgId,
    opts.authorDid,
  ]);
  await space.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
    [opts.msgId, Buffer.from(opts.body), opts.msgId, 1_700_000_000_000],
  );
  if (opts.replyTo) {
    await space.run("insert into edges (head, tail, label) values (?, ?, 'reply')", [
      opts.msgId,
      opts.replyTo,
    ]);
  }
}

/** Install a Qdrant double returning a hit for each of `messageIds`. */
function installHits(messageIds: string[]): void {
  _setQdrantClientForTest(
    new FakeQdrant(
      messageIds.map((messageId, i) => ({
        id: `point-${messageId}`,
        score: messageIds.length - i,
        payload: {
          messageId,
          spaceDid: SPACE,
          roomId: ROOM,
          threadId: null,
          authorDid: "did:plc:any",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      })),
    ),
  );
}

describe("search.messages redacts blocked authors", () => {
  test("a blocked author's hit and reply target are redacted for an ordinary member", async () => {
    await makeMember(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    installHits([MSG_BLOCKED, MSG_VISIBLE, MSG_REPLY]);

    const result = await searchMessagesHandler(
      { q: "body", spaceId: SPACE },
      { did: VIEWER },
    );

    const blocked = result.messages.find((m) => m.id === MSG_BLOCKED);
    expect(blocked).toBeDefined();
    expect(blocked!.blocked).toBe(true);
    expect(blocked!.content).toBe("");
    expect(blocked!.authorName).toBe("");
    expect(blocked!.authorAvatar).toBeUndefined();

    // Reply attachment: the hit survives, but its target is a tombstone.
    const reply = result.messages.find((m) => m.id === MSG_REPLY);
    expect(reply).toBeDefined();
    expect(reply!.reply?.message).toBeDefined();
    expect(reply!.reply!.message!.blocked).toBe(true);
    expect(reply!.reply!.message!.content).toBe("");
    expect(reply!.reply!.message!.authorName).toBe("");
    expect(reply!.reply!.message!.authorAvatar).toBeUndefined();

    // Positive control: a non-blocked author's hit is intact.
    const visible = result.messages.find((m) => m.id === MSG_VISIBLE);
    expect(visible).toBeDefined();
    expect(visible!.blocked).toBeUndefined();
    expect(visible!.content).toBe(VISIBLE_BODY);
    expect(visible!.authorName).toBe("Visible Author");

    // No blocked body or identity anywhere in the wire response.
    const json = JSON.stringify(result);
    expect(json).not.toContain(BLOCKED_BODY);
    expect(json).not.toContain(REPLY_TARGET_BODY);
    expect(json).not.toContain(AUTHOR_NAME);
    expect(json).not.toContain(AUTHOR_AVATAR);
  });

  test("a space admin gets the exact same redaction — no reveal on search", async () => {
    await makeAdmin(VIEWER);
    await seedBlockSet(VIEWER, [AUTHOR]);
    installHits([MSG_BLOCKED, MSG_VISIBLE, MSG_REPLY]);

    const result = await searchMessagesHandler(
      { q: "body", spaceId: SPACE },
      { did: VIEWER },
    );

    const blocked = result.messages.find((m) => m.id === MSG_BLOCKED);
    expect(blocked!.blocked).toBe(true);
    expect(blocked!.content).toBe("");
    expect(blocked!.authorName).toBe("");
    expect(blocked!.authorAvatar).toBeUndefined();

    const reply = result.messages.find((m) => m.id === MSG_REPLY);
    expect(reply!.reply!.message!.blocked).toBe(true);
    expect(reply!.reply!.message!.content).toBe("");
    expect(reply!.reply!.message!.authorName).toBe("");
    expect(reply!.reply!.message!.authorAvatar).toBeUndefined();

    const visible = result.messages.find((m) => m.id === MSG_VISIBLE);
    expect(visible!.blocked).toBeUndefined();
    expect(visible!.content).toBe(VISIBLE_BODY);
    expect(visible!.authorName).toBe("Visible Author");

    const json = JSON.stringify(result);
    expect(json).not.toContain(BLOCKED_BODY);
    expect(json).not.toContain(REPLY_TARGET_BODY);
    expect(json).not.toContain(AUTHOR_NAME);
    expect(json).not.toContain(AUTHOR_AVATAR);
  });
});
