import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StreamDid, UserDid, newUlid } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { toAsyncDb } from "../db/syncAdapter.ts";
import { closeDb, openDb, openGlobalDb } from "../db/db.ts";
import { selectMessages } from "./selectMessages.ts";
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
  test("orders by sort_idx, not entity id (so SQLite can use idx_entities_room_sort)", async () => {
    const db = freshSpaceDb();
    const roomId = newUlid();

    // Insert three messages whose ids are in the OPPOSITE order to their
    // sort_idx. Ordering by id (or coalesce(sort_idx, id) with a NULL
    // sort_idx) would return them wrong; ordering by sort_idx directly uses
    // the index and follows the canonical timestamp, not the event id.
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
