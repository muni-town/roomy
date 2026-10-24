import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { closeDb, openDb, openGlobalDb } from "../db/db.ts";
import { writeSettledLinkEmbed } from "../embed/store.ts";
import { selectMessages, roomPageSql } from "./selectMessages.ts";
import { _profileHydrationInFlight, _resetProfileStoreCache, _setTestGetProfiles } from "./profileStore.ts";
import { _resetProfileNegativeCache } from "../materialization/profiles.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");

beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetProfileStoreCache();
  _resetProfileNegativeCache();
});
afterEach(() => closeDb());

/** Raw in-memory per-space DB seeded with schema-space.sql. */
function freshSpaceDb(): DbLike {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return toAsyncDb(db);
}

/** Seed the global profile store (via the worker global DB). */
async function seedGlobalProfile(
  did: string,
  handle: string | null,
  name: string | null,
): Promise<void> {
  const g = await openGlobalDb();
  await g.run(
    "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
    [did, handle, name, Date.now()],
  );
}

describe("selectMessages system messages", () => {
  test("flags system messages and resolves the referenced user's DID label to a display name", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();

    // A system message authored by the space itself (author edge tail =
    // STREAM) referencing the joining user by DID in the deterministic label.
    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      STREAM,
    ]);
    const body = `[@${USER}](/user/${USER}) joined the space.`;
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(body), msgId],
    );

    // Both the space (author) and the joining user are in the global store, so
    // no on-demand network hydration is triggered.
    await seedGlobalProfile(STREAM, null, "Test Space");
    await seedGlobalProfile(USER, "alice.bsky.social", "Alice Example");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages.length).toBe(1);
    const m = messages[0]!;
    expect(m.system).toBe(true);
    // The DID label must be replaced by the display name (no leading @ — the
    // @ marker is only for handle labels); the raw DID never shows in the
    // message body.
    expect(m.content).toBe(`[Alice Example](/user/${USER}) joined the space.`);
    // The raw DID must never appear as the visible link label.
    expect(m.content).not.toContain(`[@${USER}]`);
  });

  test("users with only a handle keep the leading @ in the label", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();

    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      STREAM,
    ]);
    const body = `[@${USER}](/user/${USER}) joined the space.`;
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(body), msgId],
    );

    await seedGlobalProfile(STREAM, null, "Test Space");
    // No display name — only a handle.
    await seedGlobalProfile(USER, "alice.bsky.social", null);

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages.length).toBe(1);
    const m = messages[0]!;
    expect(m.system).toBe(true);
    // Handle labels keep the @ marker; display names drop it.
    expect(m.content).toBe(`[@alice.bsky.social](/user/${USER}) joined the space.`);
  });

  test("an empty display name (Bluesky displayName:'') falls back to the handle", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();

    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      STREAM,
    ]);
    const body = `[@${USER}](/user/${USER}) joined the space.`;
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(body), msgId],
    );

    await seedGlobalProfile(STREAM, null, "Test Space");
    // The Bluesky appview returns displayName:"" for users without one — the
    // empty string must NOT win over the handle (the raw DID must never be the
    // visible label).
    await seedGlobalProfile(USER, "alice.bsky.social", "");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages.length).toBe(1);
    const m = messages[0]!;
    expect(m.system).toBe(true);
    expect(m.content).toBe(`[@alice.bsky.social](/user/${USER}) joined the space.`);
    // The raw DID must never appear as the visible link label.
    expect(m.content).not.toContain(`[@${USER}]`);
  });

  test("user-authored messages are not flagged system and are not rewritten", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();

    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run("insert into entities (id, stream_id) values (?, ?)", [USER, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      USER,
    ]);
    const body = `[@Alice Example](/user/${USER}) hello`;
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(body), msgId],
    );

    await seedGlobalProfile(USER, "alice.bsky.social", "Alice Example");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages.length).toBe(1);
    const m = messages[0]!;
    expect(m.system).toBeUndefined();
    // Not a system message: content left untouched.
    expect(m.content).toBe(body);
  });
});

describe("selectMessages nested forwards", () => {
  /** Seed content + author edge for a message row. */
  async function seedContent(
    db: DbLike,
    messageId: string,
    content: string,
  ): Promise<void> {
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [messageId, Buffer.from(content), messageId, 1_700_000_000_000],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      messageId,
      USER,
    ]);
  }

  /**
   * Seed a forward-as-embed row: a real message with its own content plus a
   * `forward` edge to an original in another room (mirroring the
   * createMessage + forward attachment materialisation).
   */
  async function seedForward(
    db: DbLike,
    roomId: string,
    forwardId: string,
    originalId: string,
    originalRoomId: string,
    originalRoomName: string,
    ownContent: string,
  ): Promise<void> {
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [USER, STREAM]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [forwardId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      forwardId,
      USER,
    ]);
    if (ownContent) {
      await db.run(
        "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
        [forwardId, Buffer.from(ownContent), forwardId],
      );
    }
    // The original's entity + its room's info (forward_target_room_name join).
    // `or ignore` so chained forwards (originalId already materialised as a
    // forward row) don't trip the PK.
    await db.run(
      "insert or ignore into entities (id, stream_id, room) values (?, ?, ?)",
      [originalId, STREAM, originalRoomId],
    );
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      originalRoomId,
      STREAM,
    ]);
    await db.run("insert or replace into comp_info (entity, name) values (?, ?)", [
      originalRoomId,
      originalRoomName,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'forward')", [
      forwardId,
      originalId,
    ]);
  }

  test("forward-as-embed rows carry the nested denormalised original (no substitution)", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const channelId = newUlid();

    const originalId = newUlid();
    const fwdId = newUlid();

    // seedForward creates the entities (original + its room) first, so the
    // content/author inserts below don't trip entity FKs.
    await seedForward(db, roomId, fwdId, originalId, channelId, "General", "");
    await seedContent(db, originalId, "original body");

    await seedGlobalProfile(USER, "alice.bsky.social", "Alice Example");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages).toHaveLength(1);
    const fwd = messages[0]!;
    // The forward row keeps the forwarder's own (empty) content — the
    // original is nested, never substituted into the row.
    expect(fwd.id).toBe(fwdId);
    expect(fwd.content).toBe("");
    expect(fwd.authorDid).toBe(USER);
    // ForwardedFrom keeps the compat fields + the nested denormalised message.
    expect(fwd.forwardedFrom?.messageId).toBe(originalId);
    expect(fwd.forwardedFrom?.roomId).toBe(channelId);
    expect(fwd.forwardedFrom?.name).toBe("General");
    const orig = fwd.forwardedFrom?.message;
    expect(orig?.id).toBe(originalId);
    expect(orig?.content).toBe("original body");
    expect(orig?.authorDid).toBe(USER);
    expect(orig?.authorName).toBe("Alice Example");
    expect(orig?.timestamp).toBeTruthy();
  });

  test("nested forwards resolve through multiple levels", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const channelId = newUlid();
    const room2 = newUlid();

    // Chain: a forward of a forward. topFwdId (room) embeds midFwdId
    // (channel), which itself embeds rootOriginalId (room2).
    const rootOriginalId = newUlid();
    const midFwdId = newUlid();
    const topFwdId = newUlid();

    await seedForward(db, channelId, midFwdId, rootOriginalId, room2, "Room 2", "mid note");
    await seedForward(db, roomId, topFwdId, midFwdId, channelId, "General", "");
    await seedContent(db, rootOriginalId, "root body");

    await seedGlobalProfile(USER, "alice.bsky.social", "Alice Example");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    expect(messages).toHaveLength(1);
    const top = messages[0]!;
    expect(top.id).toBe(topFwdId);
    // Level 1: the embedded original is the channel-level forward.
    const mid = top.forwardedFrom?.message;
    expect(mid?.id).toBe(midFwdId);
    expect(mid?.content).toBe("mid note");
    // Level 2: that forward's own embedded original is the root message.
    const root = mid?.forwardedFrom?.message;
    expect(root?.id).toBe(rootOriginalId);
    expect(root?.content).toBe("root body");
    // The root has no further forward chain.
    expect(root?.forwardedFrom).toBeUndefined();
  });
});

describe("selectMessages room ordering", () => {
  test("orders by sort_idx, not entity id", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();

    // Insert three messages whose ids are in the OPPOSITE order to their
    // sort_idx. Ordering by id would return them wrong; ordering by sort_idx
    // follows the canonical timestamp, not the event id.
    const mk = (id: string, sortIdx: string, body: string) => ({
      id,
      sortIdx,
      body,
    });
    const msgs = [
      mk("msg-c", "sort-1", "oldest"),
      mk("msg-a", "sort-3", "newest"),
      mk("msg-b", "sort-2", "middle"),
    ];

    for (const m of msgs) {
      await db.run(
        "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
        [m.id, STREAM, roomId, m.sortIdx],
      );
      await db.run(
        "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
        [m.id, Buffer.from(m.body), m.id],
      );
    }

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    // selectMessages returns oldest → newest (it re-sorts the fetched page
    // ascending in JS). The SQL fetch is newest-first by sort_idx; the point
    // of this test is that ordering follows sort_idx (canonical timestamp),
    // NOT the entity id — msg-a has the newest sort_idx but the oldest id.
    expect(messages.map((m) => m.content)).toEqual(["oldest", "middle", "newest"]);
  });
});

describe("selectMessages edit marker", () => {
  /**
   * Seed a message whose `comp_content.last_edit` is the given value. The
   * materialiser stamps `last_edit` with the creating event's own id on
   * insert and with the edit event's id on every edit, so the default here
   * (the message's own id) is exactly the shape a never-edited message has.
   */
  async function seedMessage(
    db: DbLike,
    roomId: string,
    content: string,
    lastEdit?: string,
  ): Promise<string> {
    const msgId = newUlid();
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [msgId, STREAM, roomId],
    );
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(content), lastEdit ?? msgId],
    );
    return msgId;
  }

  test("reports the edit event id after an edit, and omits it when unedited", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();

    const editedId = await seedMessage(
      db,
      roomId,
      "edited body",
      "01HXSXKBQ4TESTEDIT0000000B",
    );
    const pristineId = await seedMessage(db, roomId, "original body");

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 50,
      cursor: null,
    });

    const edited = messages.find((m) => m.id === editedId)!;
    expect(edited.content).toBe("edited body");
    // The marker is the edit EVENT id, not a timestamp.
    expect(edited.lastEdit).toBe("01HXSXKBQ4TESTEDIT0000000B");

    // An unedited message's `last_edit` is its own creating event id — the
    // column's insert value, not evidence of an edit — so the DTO must not
    // carry a marker for it.
    const pristine = messages.find((m) => m.id === pristineId)!;
    expect(pristine.lastEdit).toBeUndefined();
  });
});

describe("selectMessages missing-author hydration", () => {
  /**
   * These two cases hold the stub's gate open for the whole test, so the only
   * way they can finish is if the read does NOT wait for the fetch. That makes
   * the timeout the failure mode — hence the explicit short one, instead of
   * bun's 5s default: a read that parks on the gate fails in 1.5s with the name
   * that says why.
   */
  const GATED_READ_TIMEOUT_MS = 1500;

  /**
   * A cross-stream author with no global `profiles` row makes the read path
   * self-heal: it hydrates in the background. That lookup must not be repeated
   * for the same DID on every subsequent read — the backoff the write path
   * uses applies to readers too.
   */
  async function seedMessageByUnknownAuthor(): Promise<{ db: DbLike; roomId: string }> {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();
    const author = "did:plc:read-path-ghost";

    // The author entity itself is not in the global `profiles` table — that
    // absence is what triggers hydration.
    await db.run("insert into entities (id, stream_id) values (?, ?)", [STREAM, STREAM]);
    await db.run("insert into entities (id, stream_id) values (?, ?)", [author, author]);
    await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      msgId,
      STREAM,
      roomId,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      author,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from("hello"), msgId],
    );
    return { db, roomId };
  }

  test(
    "serves the page without waiting for the fetch, then hydrates once",
    async () => {
      // The whole point of the deferral: the caller must not be parked on the
      // profile round-trip. The stub is gated so the fetch cannot possibly have
      // finished before the read returns.
      const gate = Promise.withResolvers<void>();
      let attempts = 0;
      _setTestGetProfiles(async () => {
        attempts++;
        await gate.promise;
        return [];
      });

      try {
        const { db, roomId } = await seedMessageByUnknownAuthor();

        // Resolves while the fetch is still blocked in the stub.
        const { messages } = await selectMessages(db, {
          kind: "room",
          roomId,
          limit: 50,
          cursor: null,
        });
        expect(attempts).toBe(1);
        expect(messages).toHaveLength(1);
        // The message renders from the pre-fetch state, with the author's own
        // fallback fields (the client shows the DID until the row lands).
        expect(messages[0]!.authorDid).toBe("did:plc:read-path-ghost");

        gate.resolve();
        await Promise.all(_profileHydrationInFlight());

        // The DID resolved to nothing, so the negative cache suppresses the
        // retry — same backoff the write path uses.
        await selectMessages(db, { kind: "room", roomId, limit: 50, cursor: null });
        await Promise.all(_profileHydrationInFlight());
        expect(attempts).toBe(1);
      } finally {
        gate.resolve();
        _setTestGetProfiles(null);
      }
    },
    GATED_READ_TIMEOUT_MS,
  );

  test(
    "concurrent reads of the same unknown author share one fetch",
    async () => {
      // Without in-flight dedup, N simultaneous readers each start their own
      // batch — measured on the real pipeline as 25 readers → 25 upstream
      // requests for one cold author.
      const gate = Promise.withResolvers<void>();
      let attempts = 0;
      _setTestGetProfiles(async () => {
        attempts++;
        await gate.promise;
        return [];
      });

      try {
        const { db, roomId } = await seedMessageByUnknownAuthor();

        await Promise.all(
          Array.from({ length: 8 }, () =>
            selectMessages(db, { kind: "room", roomId, limit: 50, cursor: null }),
          ),
        );
        // Eight simultaneous readers, one fetch: the later ones joined the
        // batch already in flight for this DID instead of starting their own.
        expect(attempts).toBe(1);

        gate.resolve();
        await Promise.all(_profileHydrationInFlight());
      } finally {
        gate.resolve();
        _setTestGetProfiles(null);
      }
    },
    GATED_READ_TIMEOUT_MS,
  );

  test("a row written by the fetch is visible on the next read", async () => {
    // The read path caches what it read *before* the fetch started. That
    // positive entry must not pin the pre-fetch values for the rest of its
    // 60 s TTL once the fetch has written fresh ones.
    const AUTHOR = "did:plc:read-path-ghost";
    const g = await openGlobalDb();
    await g.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      // 2 hours old — past the 30-minute refresh TTL, so the read starts a
      // refresh and serves "Old Name" meanwhile.
      [AUTHOR, "alice.bsky.social", "Old Name", Date.now() - 2 * 60 * 60 * 1000],
    );
    await g.run(
      "insert into profiles (did, handle, name, updated_at) values (?, ?, ?, ?)",
      [STREAM, null, "Test Space", Date.now()],
    );

    const gate = Promise.withResolvers<void>();
    _setTestGetProfiles(async () => {
      await gate.promise;
      return [];
    });

    try {
      const { db, roomId } = await seedMessageByUnknownAuthor();

      const first = await selectMessages(db, { kind: "room", roomId, limit: 50, cursor: null });
      expect(first.messages[0]!.authorName).toBe("Old Name");

      // Stands in for the fetch's write-back (the test stub deliberately does
      // not reach the pipeline that writes the row).
      await g.run("update profiles set name = ?, updated_at = ? where did = ?", [
        "New Name",
        Date.now(),
        AUTHOR,
      ]);
      gate.resolve();
      await Promise.all(_profileHydrationInFlight());

      const second = await selectMessages(db, { kind: "room", roomId, limit: 50, cursor: null });
      expect(second.messages[0]!.authorName).toBe("New Name");
    } finally {
      gate.resolve();
      _setTestGetProfiles(null);
    }
  });
});

describe("selectMessages room page plan", () => {
  /**
   * The room page is ordered by `coalesce(sort_idx, id)` and seeks the next
   * page on that same expression. The index `idx_entities_room_sort_key`
   * exists to serve exactly that ORDER BY — without it SQLite sorts every
   * entity in the room into a temp B-tree on each fetch, which is where a
   * large bridged channel spends its read time. Asserted on the SQL the read
   * path runs, in both call forms, because a cursor page is a different
   * statement from a first page.
   */
  test("the room page walks idx_entities_room_sort_key, with and without a cursor", () => {
    const db = new Database(":memory:");
    db.exec("pragma foreign_keys = on");
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));

    for (const hasCursor of [false, true]) {
      const plan = db
        .query<{ detail: string }, []>(
          `explain query plan ${roomPageSql(hasCursor, 50)}`,
        )
        .all()
        .map((r) => r.detail)
        .join(" | ");

      expect(plan).not.toMatch(/TEMP B-TREE/);
      expect(plan).toContain("idx_entities_room_sort_key");
    }
  });
});

describe("selectMessages blocked authors", () => {
  const VIEWER = UserDid.assert("did:plc:viewer");
  /** An author the viewer blocked: their rows are hidden from the viewer. */
  const HIDDEN = "did:plc:hidden-author";
  /** An author nothing hides. */
  const OPEN = "did:plc:open-author";

  /** The hidden set `selectMessages` would have resolved for the viewer. */
  const hiding = (...dids: string[]) => dids;

  /**
   * Seed a message by `author` carrying every attachment a tombstone has to
   * drop: a reaction, an image embed, a link embed and its enriched data.
   * Seeding them is the point — the row must come back with none of them even
   * though the batch queries, keyed on the page's ids, would have found them.
   */
  async function seedRichMessage(
    db: DbLike,
    roomId: string,
    author: string,
    sortIdx: string,
    body: string,
  ): Promise<string> {
    const id = newUlid();
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      author,
      STREAM,
    ]);
    await db.run(
      "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
      [id, STREAM, roomId, sortIdx],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      id,
      author,
    ]);
    // `comp_reaction.user` is an entity reference: the reacting user needs a
    // row.
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      OPEN,
      STREAM,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [id, Buffer.from(body), id, 1_700_000_000_000],
    );
    await db.run(
      "insert into comp_reaction (entity, user, reaction_id, reaction) values (?, ?, ?, ?)",
      [id, OPEN, newUlid(), "👍"],
    );
    // Embed entities carry the MESSAGE id in their own `room` column — that is
    // what the batch query joins on.
    const imageUrl = newUlid();
    await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      imageUrl,
      STREAM,
      id,
    ]);
    await db.run(
      "insert into comp_embed_image (entity, mime_type, width, height, alt) values (?, 'image/png', 10, 10, 'a picture')",
      [imageUrl],
    );
    // A link embed's entity id IS its URL: the store is keyed by that value,
    // and `linkEmbeds[].url` comes from the same column.
    const linkUrl = `https://example.com/${id}`;
    await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      linkUrl,
      STREAM,
      id,
    ]);
    await db.run(
      "insert into comp_embed_link (entity, show_preview) values (?, 1)",
      [linkUrl],
    );
    // Enrichment lives in the global store, keyed by the link's URL; the
    // per-space row records only that the message holds a link.
    await writeSettledLinkEmbed(
      await openGlobalDb(),
      linkUrl,
      JSON.stringify({ t: "A title" }),
      1,
    );
    return id;
  }

  test("a hidden author's row is a tombstone and the page stays the same shape", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const openId = await seedRichMessage(db, roomId, OPEN, "03", "visible body");
    const hiddenId = await seedRichMessage(db, roomId, HIDDEN, "02", "hidden body");
    const olderId = await seedRichMessage(db, roomId, OPEN, "01", "oldest body");

    await seedGlobalProfile(HIDDEN, "hidden.bsky.social", "Hidden Author");
    await seedGlobalProfile(OPEN, "open.bsky.social", "Open Author");

    const page = await selectMessages(
      db,
      { kind: "room", roomId, limit: 2, cursor: null },
      VIEWER,
      await openGlobalDb(),
      hiding(HIDDEN),
    );
    const unredacted = await selectMessages(
      db,
      { kind: "room", roomId, limit: 2, cursor: null },
      VIEWER,
      await openGlobalDb(),
      hiding(),
    );

    // Redaction keeps the row, so the page is the same length in the same
    // order and the cursor — derived from `baseRows.length === limit` — names
    // the same id. A `where`-clause filter would return one row here and,
    // when a whole page is hidden, no cursor at all: the scrollback below a
    // blocked author would silently truncate.
    expect(page.messages.map((m) => m.id)).toEqual(unredacted.messages.map((m) => m.id));
    expect(page.nextCursor).toBe(unredacted.nextCursor);
    expect(page.messages).toHaveLength(2);
    expect(page.nextCursor).toBe(hiddenId);
    expect(olderId).toBeTruthy();

    const tombstone = page.messages[0]!;
    expect(tombstone.id).toBe(hiddenId);
    expect(tombstone.blocked).toBe(true);
    expect(tombstone.content).toBe("");
    expect(tombstone.authorName).toBe("");
    expect(tombstone.authorDid).toBe(HIDDEN);
    expect(tombstone.timestamp).toBeTruthy();
    expect(tombstone.sort_idx).toBe("02");
    expect(tombstone.authorHandle).toBeUndefined();
    expect(tombstone.authorAvatar).toBeUndefined();
    expect(tombstone.mimeType).toBeUndefined();
    expect(tombstone.replyTo).toBeUndefined();
    expect(tombstone.forwardedFrom).toBeUndefined();
    expect(tombstone.lastEdit).toBeUndefined();
    expect(tombstone.system).toBeUndefined();
    expect(tombstone.reactions).toEqual([]);
    expect(tombstone.media).toEqual([]);
    expect(tombstone.linkEmbeds).toEqual([]);
    // The profile hydration pass skipped it: the row would otherwise have
    // picked up "Hidden Author" from the global store.
    expect(tombstone.authorName).not.toBe("Hidden Author");

    // Not over-broad: the rows that are not hidden keep their attachments, so
    // the emptiness above is the redaction and not a query that returned
    // nothing.
    const visible = page.messages[1]!;
    expect(visible.id).toBe(openId);
    expect(visible.blocked).toBeUndefined();
    expect(visible.content).toBe("visible body");
    expect(visible.authorName).toBe("Open Author");
    expect(visible.reactions).toHaveLength(1);
    // The image, plus the link embed — the read path carries `text/uri-list`
    // entries in `media` too, and the client filters them out when rendering.
    expect(visible.media.filter((m) => !m.type.startsWith("text/"))).toHaveLength(1);
    expect(visible.linkEmbeds).toHaveLength(1);
    expect(visible.linkEmbeds[0]!.embed).toEqual({ t: "A title" });
  });

  test("a forward of a hidden author's message redacts the embedded original", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const channelId = newUlid();
    const originalId = newUlid();
    const forwardId = newUlid();

    // `seedForward` builds the entities; the original is authored by HIDDEN
    // and the forwarder by OPEN, so only the embedded original is redacted.
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      OPEN,
      STREAM,
    ]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [forwardId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      forwardId,
      OPEN,
    ]);
    await db.run(
      "insert or ignore into entities (id, stream_id, room) values (?, ?, ?)",
      [originalId, STREAM, channelId],
    );
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      channelId,
      STREAM,
    ]);
    await db.run("insert or replace into comp_info (entity, name) values (?, ?)", [
      channelId,
      "General",
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'forward')", [
      forwardId,
      originalId,
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      HIDDEN,
      STREAM,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [originalId, Buffer.from("the original words"), originalId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      originalId,
      HIDDEN,
    ]);

    const { messages } = await selectMessages(
      db,
      { kind: "room", roomId, limit: 50, cursor: null },
      VIEWER,
      null,
      hiding(HIDDEN),
    );

    expect(messages).toHaveLength(1);
    const forward = messages[0]!;
    // The forwarder's own row survives — they are not blocked.
    expect(forward.id).toBe(forwardId);
    expect(forward.blocked).toBeUndefined();
    expect(forward.authorDid).toBe(OPEN);
    expect(forward.forwardedFrom?.messageId).toBe(originalId);

    // Only the embedded original is redacted: the original is authored by
    // HIDDEN and the forwarder by OPEN, and the forward row keeps the
    // forwarder's own identity.
    const embedded = forward.forwardedFrom?.message;
    expect(embedded?.id).toBe(originalId);
    expect(embedded?.blocked).toBe(true);
    expect(embedded?.content).toBe("");
    expect(embedded?.authorName).toBe("");
  });

  test("a forward by a hidden author is redacted wholesale", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const originalId = newUlid();
    const forwardId = newUlid();

    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      OPEN,
      STREAM,
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      HIDDEN,
      STREAM,
    ]);
    await db.run(
      "insert into entities (id, stream_id, room) values (?, ?, ?)",
      [forwardId, STREAM, roomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      forwardId,
      HIDDEN,
    ]);
    // The original lives in another room, so the forward row is the only row
    // this page carries and nothing about it can be confused with a row of
    // the page itself.
    const originalRoomId = newUlid();
    await db.run(
      "insert or ignore into entities (id, stream_id, room) values (?, ?, ?)",
      [originalId, STREAM, originalRoomId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'forward')", [
      forwardId,
      originalId,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [originalId, Buffer.from("someone else's words"), originalId],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      originalId,
      OPEN,
    ]);

    const { messages } = await selectMessages(
      db,
      { kind: "room", roomId, limit: 50, cursor: null },
      VIEWER,
      null,
      hiding(HIDDEN),
    );

    expect(messages).toHaveLength(1);
    const forward = messages[0]!;
    expect(forward.id).toBe(forwardId);
    expect(forward.blocked).toBe(true);
    expect(forward.content).toBe("");
    expect(forward.authorName).toBe("");
    // The tombstone carries no forward attachment for the original to fill.
    expect(forward.forwardedFrom).toBeUndefined();
  });

  test("a cursor page binds against the renumbered room-scope parameters", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(
        await seedRichMessage(
          db,
          roomId,
          i % 2 === 1 ? HIDDEN : OPEN,
          `0${i}`,
          `body ${i}`,
        ),
      );
    }

    // Newest-first paging, two rows at a time, with the hidden set in play.
    // The room scope binds `roomId, hidden, cursorKey, cursor` — the hidden
    // parameter sits *before* the cursor parameters — so a mis-numbered
    // statement shifts the keyset and drops or repeats rows here.
    // `selectMessages` re-sorts each page ascending (oldest → newest), the
    // reverse of the SQL page order.
    const first = await selectMessages(
      db,
      { kind: "room", roomId, limit: 2, cursor: null },
      VIEWER,
      null,
      hiding(HIDDEN),
    );
    expect(first.messages.map((m) => m.id)).toEqual([ids[3]!, ids[4]!]);
    expect(first.nextCursor).toBe(ids[3]!);

    const second = await selectMessages(
      db,
      { kind: "room", roomId, limit: 2, cursor: first.nextCursor },
      VIEWER,
      null,
      hiding(HIDDEN),
    );
    expect(second.messages.map((m) => m.id)).toEqual([ids[1]!, ids[2]!]);
    expect(second.nextCursor).toBe(ids[1]!);

    const third = await selectMessages(
      db,
      { kind: "room", roomId, limit: 2, cursor: second.nextCursor },
      VIEWER,
      null,
      hiding(HIDDEN),
    );
    expect(third.messages.map((m) => m.id)).toEqual([ids[0]!]);
    // A short page derives no cursor: the scrollback ends here.
    expect(third.nextCursor).toBeNull();

    // Every row came back exactly once, whether tombstoned or not. (Each page
    // is ascending, so the union — not the concatenation — is what has to
    // cover the room exactly.)
    const seen = [...first.messages, ...second.messages, ...third.messages];
    expect(new Set(seen.map((m) => m.id))).toEqual(new Set(ids));
    expect(seen.filter((m) => m.blocked === true)).toHaveLength(3);
  });

  test("paging continues past a fully hidden block of history", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const ids: string[] = [];
    // The three oldest rows all belong to the hidden author: a page of them
    // renders nothing but indicators, which is exactly the page a `where`
    // clause would have shortened to nothing and ended the scrollback on.
    for (let i = 1; i <= 6; i++) {
      ids.push(
        await seedRichMessage(
          db,
          roomId,
          i <= 3 ? HIDDEN : OPEN,
          `0${i}`,
          `body ${i}`,
        ),
      );
    }

    const newest = await selectMessages(
      db,
      { kind: "room", roomId, limit: 3, cursor: null },
      VIEWER,
      null,
      hiding(HIDDEN),
    );
    expect(newest.messages.map((m) => m.id)).toEqual([ids[3]!, ids[4]!, ids[5]!]);
    expect(newest.nextCursor).toBe(ids[3]!);

    const rest = await selectMessages(
      db,
      { kind: "room", roomId, limit: 3, cursor: newest.nextCursor },
      VIEWER,
      null,
      hiding(HIDDEN),
    );
    expect(rest.messages.map((m) => m.id)).toEqual([ids[0]!, ids[1]!, ids[2]!]);
    expect(rest.messages.every((m) => m.blocked === true)).toBe(true);
    expect(rest.messages.every((m) => m.content === "")).toBe(true);
    expect(rest.nextCursor).toBe(ids[0]!);
  });
});

describe("selectMessages attachments", () => {
  const VIEWER = UserDid.assert("did:plc:attachments-viewer");
  const AUTHOR = "did:plc:attachments-author";
  /** The hidden set `selectMessages` takes, as the blocked-authors suite passes it. */
  const hiding = (...dids: string[]) => dids;

  /** Every attachment kind, each with the fields its variant carries. */
  const IMAGE_URL = "01IMAGE0000000000000000000";
  const VIDEO_URL = "01VIDEO0000000000000000000";
  const FILE_URL = "01FILE00000000000000000000";
  const LINK_URL = "https://example.com/article";
  /** A tile attachment's entity key carries the message suffix, `tile_uri` does not. */
  const TILE_URL =
    "at://did:plc:ti1e0wner0000000000000/ing.dasl.masl/3kabc";
  const TILE_DATA = { rows: [1, 2], title: "a tile" };

  /**
   * Seed one message carrying a reply edge and one embed row of every kind
   * (image, video, file, link, tile), with the link enriched in the global
   * store. Returns the message id.
   */
  async function seedAllKinds(
    db: DbLike,
    roomId: string,
    parentId: string,
    sortIdx: string,
  ): Promise<string> {
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      AUTHOR,
      STREAM,
    ]);
    const id = newUlid();
    await db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
      id,
      STREAM,
      roomId,
      sortIdx,
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      AUTHOR,
      STREAM,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      id,
      AUTHOR,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [id, Buffer.from("body"), id, 1_700_000_000_000],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'reply')", [
      id,
      parentId,
    ]);
    // Embed entities carry the MESSAGE id in their own `room` column — that is
    // what the batch query joins on.
    const embed = async (url: string, insert: () => Promise<unknown>) => {
      await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
        url,
        STREAM,
        id,
      ]);
      await insert();
    };
    await embed(IMAGE_URL, () =>
      db.run(
        "insert into comp_embed_image (entity, mime_type, width, height, alt, blurhash, size) values (?, 'image/png', 10, 20, 'a picture', 'LKO2x', 42)",
        [IMAGE_URL],
      ),
    );
    await embed(VIDEO_URL, () =>
      db.run(
        "insert into comp_embed_video (entity, mime_type, width, height, length, blurhash, alt, size) values (?, 'video/mp4', 640, 480, 30, 'LKO2', 'a clip', 999)",
        [VIDEO_URL],
      ),
    );
    await embed(FILE_URL, () =>
      db.run(
        "insert into comp_embed_file (entity, mime_type, size, name) values (?, 'application/pdf', 123, 'doc.pdf')",
        [FILE_URL],
      ),
    );
    // A link embed's entity id IS its URL: the global store is keyed by that
    // value, and `linkEmbeds[].url` comes from the same column.
    await embed(LINK_URL, () =>
      db.run("insert into comp_embed_link (entity, show_preview) values (?, 1)", [
        LINK_URL,
      ]),
    );
    await writeSettledLinkEmbed(
      await openGlobalDb(),
      LINK_URL,
      JSON.stringify({ t: "A title" }),
      1,
    );
    // A tile is keyed like the other embed rows but stores the bare address,
    // which is the only form its loader parses.
    const scopedTile = `${TILE_URL}?message=${id}`;
    await embed(scopedTile, () =>
      db.run("insert into comp_embed_tile (entity, tile_uri, data) values (?, ?, ?)", [
        scopedTile,
        TILE_URL,
        JSON.stringify(TILE_DATA),
      ]),
    );
    return id;
  }

  test("the one list carries every kind, and the derived views match what the per-kind fields held", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const parentId = newUlid();
    await db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
      parentId,
      STREAM,
      roomId,
      "01",
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      AUTHOR,
      STREAM,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      parentId,
      AUTHOR,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [parentId, Buffer.from("parent"), parentId, 1_700_000_000_000],
    );

    const id = await seedAllKinds(db, roomId, parentId, "02");

    const { messages } = await selectMessages(
      db,
      { kind: "room", roomId, limit: 10, cursor: null },
      VIEWER,
      await openGlobalDb(),
    );
    const m = messages.find((x) => x.id === id)!;

    // The reply and forward edges are addressed by id, not by url, so they
    // lead the list; the embed rows follow in the query's kind order
    // (image, video, file, link, tile).
    expect(m.attachments.map((a) => a.$type)).toEqual([
      "space.roomy.attachment.reply.v0",
      "space.roomy.attachment.image.v0",
      "space.roomy.attachment.video.v0",
      "space.roomy.attachment.file.v0",
      "space.roomy.attachment.link.v0",
      "space.roomy.attachment.tile.v0",
    ]);

    // Each entry carries what its renderer needs — this is what a renderer
    // dispatches on instead of being handed a fifth parallel field.
    expect(m.attachments[1]).toEqual({
      $type: "space.roomy.attachment.image.v0",
      url: IMAGE_URL,
      type: "image/png",
      alt: "a picture",
      width: 10,
      height: 20,
      blurhash: "LKO2x",
      size: 42,
    });
    expect(m.attachments[2]).toEqual({
      $type: "space.roomy.attachment.video.v0",
      url: VIDEO_URL,
      type: "video/mp4",
      alt: "a clip",
      width: 640,
      height: 480,
      blurhash: "LKO2",
      size: 999,
      length: 30,
    });
    expect(m.attachments[3]).toEqual({
      $type: "space.roomy.attachment.file.v0",
      url: FILE_URL,
      type: "application/pdf",
      size: 123,
      name: "doc.pdf",
    });
    expect(m.attachments[4]).toEqual({
      $type: "space.roomy.attachment.link.v0",
      url: LINK_URL,
      embed: { t: "A title" },
    });
    // A tile's `url` is the bare record address (the entity key's
    // `?message=` suffix would make it unparseable as a tile), and its payload
    // arrives parsed.
    expect(m.attachments[5]).toEqual({
      $type: "space.roomy.attachment.tile.v0",
      url: TILE_URL,
      data: TILE_DATA,
    });
    expect(m.attachments[0]).toEqual({
      $type: "space.roomy.attachment.reply.v0",
      messageId: parentId,
    });

    // The derived views are what the per-kind fields held before the list
    // existed: a link reaches `media` as a `text/uri-list` row (the media
    // renderers filter it out by MIME type) as well as `linkEmbeds`. A tile is
    // neither — it is rendered from its own record, so it appears in the list
    // and in neither view.
    expect(m.media).toEqual([
      { url: IMAGE_URL, type: "image/png", alt: "a picture", width: 10, height: 20, blurhash: "LKO2x", size: 42 },
      { url: VIDEO_URL, type: "video/mp4", alt: "a clip", width: 640, height: 480, blurhash: "LKO2", size: 999, length: 30 },
      { url: FILE_URL, type: "application/pdf", size: 123, name: "doc.pdf" },
      { url: LINK_URL, type: "text/uri-list" },
    ]);
    expect(m.linkEmbeds).toEqual([{ url: LINK_URL, embed: { t: "A title" } }]);
    expect(m.replyTo).toBe(parentId);
  });

  test("a link the author dismissed is absent from both the list and the derived views", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const id = newUlid();
    await db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
      id,
      STREAM,
      roomId,
      "01",
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      AUTHOR,
      STREAM,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      id,
      AUTHOR,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [id, Buffer.from("body"), id, 1_700_000_000_000],
    );
    await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      LINK_URL,
      STREAM,
      id,
    ]);
    await db.run("insert into comp_embed_link (entity, show_preview) values (?, 0)", [
      LINK_URL,
    ]);

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 10,
      cursor: null,
    });
    const m = messages.find((x) => x.id === id)!;

    // The projection drops the row, so a dismissed preview is indistinguish-
    // able from a message that never had one — in the list as well as in the
    // two views derived from it.
    expect(m.attachments).toEqual([]);
    expect(m.media).toEqual([]);
    expect(m.linkEmbeds).toEqual([]);
  });

  test("a tile whose stored payload is not JSON keeps the attachment and drops the payload", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const id = newUlid();
    await db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
      id,
      STREAM,
      roomId,
      "01",
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      AUTHOR,
      STREAM,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      id,
      AUTHOR,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [id, Buffer.from("body"), id, 1_700_000_000_000],
    );
    const scopedTile = `${TILE_URL}?message=${id}`;
    await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      scopedTile,
      STREAM,
      id,
    ]);
    // The writer can only produce valid JSON; a row like this one is what a
    // future or wrong writer would leave. A read must not fail on it.
    await db.run("insert into comp_embed_tile (entity, tile_uri, data) values (?, ?, ?)", [
      scopedTile,
      TILE_URL,
      "{not json",
    ]);

    const { messages } = await selectMessages(db, {
      kind: "room",
      roomId,
      limit: 10,
      cursor: null,
    });
    const m = messages.find((x) => x.id === id)!;

    expect(m.attachments).toEqual([
      { $type: "space.roomy.attachment.tile.v0", url: TILE_URL },
    ]);
  });

  test("a forward carries the original as an attachment, and the derived forward view is that entry", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const originalId = newUlid();
    await db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
      originalId,
      STREAM,
      roomId,
      "01",
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      AUTHOR,
      STREAM,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      originalId,
      AUTHOR,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [originalId, Buffer.from("the original"), originalId, 1_700_000_000_000],
    );
    await seedGlobalProfile(AUTHOR, "author.bsky.social", "Author");

    const forwardId = newUlid();
    await db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
      forwardId,
      STREAM,
      roomId,
      "02",
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      USER,
      STREAM,
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      USER,
      STREAM,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      forwardId,
      USER,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [forwardId, Buffer.from(""), forwardId, 1_700_000_001_000],
    );
    await db.run("insert into edges (head, tail, label) values (?, ?, 'forward')", [
      forwardId,
      originalId,
    ]);

    const { messages } = await selectMessages(
      db,
      { kind: "room", roomId, limit: 10, cursor: null },
      VIEWER,
      await openGlobalDb(),
    );
    const m = messages.find((x) => x.id === forwardId)!;

    const forward = m.attachments.find(
      (a) => a.$type === "space.roomy.attachment.forward.v0",
    );
    expect(forward).toBeDefined();
    if (forward?.$type !== "space.roomy.attachment.forward.v0") throw new Error("unreachable");
    expect(forward.messageId).toBe(originalId);
    expect(forward.message?.id).toBe(originalId);
    expect(forward.message?.content).toBe("the original");
    // The derived view is the same entry, in the shape the forward context
    // line has always read.
    expect(m.forwardedFrom).toEqual({
      messageId: originalId,
      name: "",
      roomId,
      message: forward.message,
    });
  });

  test("the tombstone carries an empty list, so no kind leaks through the redaction", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const parentId = newUlid();
    await db.run("insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)", [
      parentId,
      STREAM,
      roomId,
      "01",
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      AUTHOR,
      STREAM,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      parentId,
      AUTHOR,
    ]);
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) values (?, 'text/markdown', ?, ?, ?)",
      [parentId, Buffer.from("parent"), parentId, 1_700_000_000_000],
    );

    const id = await seedAllKinds(db, roomId, parentId, "02");
    const { messages } = await selectMessages(
      db,
      { kind: "room", roomId, limit: 10, cursor: null },
      VIEWER,
      await openGlobalDb(),
      hiding(AUTHOR),
    );
    const m = messages.find((x) => x.id === id)!;

    expect(m.blocked).toBe(true);
    expect(m.attachments).toEqual([]);
    expect(m.media).toEqual([]);
    expect(m.linkEmbeds).toEqual([]);
    expect(m.replyTo).toBeUndefined();
  });
});

describe("selectMessages attachment-encoded links", () => {
  test("an attachment-only link resolves its card from the canonical store key", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();
    const msgId = newUlid();
    const url = "https://example.com/article";
    // Exactly what the SDK message materialiser stores for a `link.v0`
    // attachment: the entity id is the URL plus Roomy's message encoding.
    const entityId = `${url}?message=${msgId}`;

    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      STREAM,
      STREAM,
    ]);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
      USER,
      STREAM,
    ]);
    await db.run("insert into entities (id, stream_id, room) values (?, ?, ?)", [
      msgId,
      STREAM,
      roomId,
    ]);
    await db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
      msgId,
      USER,
    ]);
    // The message's entire payload is the link attachment: no body URLs.
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit) values (?, 'text/markdown', ?, ?)",
      [msgId, Buffer.from(""), msgId],
    );
    await db.run("insert into entities (id, stream_id, room) values (?, '', ?)", [
      entityId,
      msgId,
    ]);
    await db.run(
      "insert into comp_embed_link (entity, show_preview) values (?, 1)",
      [entityId],
    );

    // The enricher keys the store by the bare URL, never the entity id.
    const globalDb = await openGlobalDb();
    await writeSettledLinkEmbed(
      globalDb,
      url,
      JSON.stringify({ t: "Article" }),
      1,
    );

    const { messages } = await selectMessages(
      db,
      {
        kind: "room",
        roomId,
        limit: 10,
        cursor: null,
      },
      undefined,
      globalDb,
    );

    expect(messages).toHaveLength(1);
    const linkEmbeds = messages[0]!.linkEmbeds;
    expect(linkEmbeds).toHaveLength(1);
    // The display URL stays the entity id: the client's dismiss/re-add toggle
    // compares it against the attachment `uri` it sends in the edit.
    expect(linkEmbeds[0]!.url).toBe(entityId);
    expect(linkEmbeds[0]!.embed).toEqual({ t: "Article" });
  });
});
