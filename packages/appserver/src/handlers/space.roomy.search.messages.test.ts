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

import { closeDb, openDb, openGlobalDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import {
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { setFlagGlobal } from "../queries/featureFlags.ts";
import {
  _resetQdrantClient,
  _setQdrantClientForTest,
  type QdrantClientLike,
} from "../search/qdrantSearch.ts";
import { metrics } from "../metrics.ts";
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
  // The block feature is off by default; these tests are about its enforcement.
  await setFlagGlobal(openReadStateDb(), "user-blocks", true);
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
  room?: string;
}): Promise<void> {
  const space = openSpaceDb(SPACE);
  await space.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [opts.msgId, SPACE, opts.room ?? ROOM, opts.msgId],
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

/**
 * DB worker round-trips observed so far. Every request through a worker link
 * observes the `roomy_db_wait_seconds` histogram, so the sum of its counts is
 * the number of statements the handler spent — read with zero instrumentation
 * of the handler itself.
 */
function dbRoundTrips(): number {
  let total = 0;
  for (const m of metrics.render().matchAll(
    /^roomy_db_wait_seconds_count\{[^}]*\} (\d+)$/gm,
  )) {
    total += Number(m[1]);
  }
  return total;
}

describe("search.messages reply context is batched", () => {
  /**
   * Reply denormalisation used to resolve each hit's target on its own: an
   * entity→space lookup, an entity→room read and a message hydration per
   * reply. The page's targets are now resolved in one pass per target space,
   * so a page of N replies must cost what a page of one reply costs.
   */
  test("a page of replies issues a constant number of statements", async () => {
    await makeMember(VIEWER);

    const count = 8;
    const replyIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const targetId = `msg-target-${i}`;
      const replyId = `msg-reply-${i}`;
      replyIds.push(replyId);
      await seedMessage({
        msgId: targetId,
        authorDid: VISIBLE_AUTHOR,
        body: `target body ${i}`,
      });
      await seedMessage({
        msgId: replyId,
        authorDid: VISIBLE_AUTHOR,
        body: `reply body ${i}`,
        replyTo: targetId,
      });
      for (const id of [targetId, replyId]) {
        await openGlobalDb().run(
          "insert into entity_space (entity_id, space_did) values (?, ?)",
          [id, SPACE],
        );
      }
    }

    /** Run the handler over `messageIds` and return its statement cost. */
    async function measure(messageIds: string[]) {
      installHits(messageIds);
      const before = dbRoundTrips();
      const result = await searchMessagesHandler(
        { q: "body", spaceId: SPACE },
        { did: VIEWER },
      );
      return { result, statements: dbRoundTrips() - before };
    }

    // Warm the process-level caches (profile store, block sets) so neither
    // measured run pays a one-off first-call cost.
    await measure([replyIds[0]!]);

    const one = await measure([replyIds[0]!]);
    const many = await measure(replyIds);

    // Behaviour preserved: every reply resolves to its fully hydrated target.
    expect(one.result.messages).toHaveLength(1);
    expect(one.result.messages[0]!.reply?.message?.content).toBe("target body 0");
    expect(many.result.messages).toHaveLength(count);
    for (const message of many.result.messages) {
      expect(message.reply?.messageId).toBeDefined();
      expect(message.reply?.message?.content).toContain("target body");
    }

    // Eight replies, no meaningful extra SQL. A per-reply path costs three or
    // more statements each, so this fails by an order of magnitude on one.
    expect(many.statements - one.statements).toBeLessThanOrEqual(2);
  });

  test("an unresolvable or unreadable target degrades to the id alone", async () => {
    await makeMember(VIEWER);
    // A room whose `default_access` denies reads to a plain member.
    const PRIVATE_ROOM = "room-private";
    await openSpaceDb(SPACE).run(
      "insert into entities (id, stream_id) values (?, ?)",
      [PRIVATE_ROOM, SPACE],
    );
    await openSpaceDb(SPACE).run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'none')",
      [PRIVATE_ROOM],
    );

    // The target of the first reply is materialised but never indexed in
    // `entity_space`, so its owning space cannot be resolved.
    await seedMessage({ msgId: "msg-unindexed", authorDid: VISIBLE_AUTHOR, body: "unindexed" });
    await seedMessage({
      msgId: "msg-unresolvable",
      authorDid: VISIBLE_AUTHOR,
      body: "reply to an unindexed target",
      replyTo: "msg-unindexed",
    });
    // The second target resolves in this space, but lives in a room the
    // caller cannot read.
    await seedMessage({
      msgId: "msg-in-private-room",
      authorDid: VISIBLE_AUTHOR,
      body: "secret body",
      room: PRIVATE_ROOM,
    });
    await seedMessage({
      msgId: "msg-unreadable",
      authorDid: VISIBLE_AUTHOR,
      body: "reply to a private-room target",
      replyTo: "msg-in-private-room",
    });
    for (const id of ["msg-unresolvable", "msg-unreadable", "msg-in-private-room"]) {
      await openGlobalDb().run(
        "insert into entity_space (entity_id, space_did) values (?, ?)",
        [id, SPACE],
      );
    }

    installHits(["msg-unresolvable", "msg-unreadable"]);
    const result = await searchMessagesHandler(
      { q: "body", spaceId: SPACE },
      { did: VIEWER },
    );

    // Both hits survive; neither carries a target the caller may not see.
    expect(result.messages).toHaveLength(2);
    expect(result.messages.find((m) => m.id === "msg-unresolvable")!.reply).toEqual({
      messageId: "msg-unindexed",
    });
    expect(result.messages.find((m) => m.id === "msg-unreadable")!.reply).toEqual({
      messageId: "msg-in-private-room",
    });
    expect(JSON.stringify(result)).not.toContain("secret body");
  });
});

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
