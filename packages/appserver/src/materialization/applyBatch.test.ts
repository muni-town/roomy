import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { ulid } from "ulidx";
import {
  StreamDid,
  StreamIndex,
  UserDid,
  newUlid,
  type DecodedStreamEvent,
  type Event,
} from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import type { SQLQueryBindings } from "bun:sqlite";

import { toAsyncDb } from "../db/syncAdapter.ts";
import { closeDb, openDb, openReadStateDb } from "../db/db.ts";
import { applyBatch } from "./applyBatch.ts";
import { applyBundle } from "./applyBundle.ts";
import type { StatementBundleSuccess } from "./types.ts";
import { selectMessages } from "../queries/selectMessages.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, "..", "db", "schema-space.sql");
const GLOBAL_SCHEMA_PATH = join(__dirname, "..", "db", "schema-global.sql");

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");

// applyBatch's side-effect path calls openReadStateDb() (and selectMessages
// calls tryOpenGlobalDb()), which route to the worker-backed DBs. Initialise
// the worker with :memory: DBs so those side effects never touch real files
// (a leftover data/global.sqlite with an old schema version would otherwise
// throw "Schema version mismatch").
beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
});
afterEach(() => {
  closeDb();
});

/** Raw in-memory per-space DB seeded with schema-space.sql. */
function freshDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  return { db, asyncDb: toAsyncDb(db) };
}

/** Raw in-memory global DB seeded with schema-global.sql (membership edges). */
function freshGlobalDb(): { db: Database; asyncDb: DbLike } {
  const db = new Database(":memory:");
  db.exec("pragma journal_mode = wal");
  db.exec("pragma synchronous = normal");
  db.exec("pragma foreign_keys = on");
  const schemaSql = readFileSync(GLOBAL_SCHEMA_PATH, "utf8");
  db.exec(schemaSql);
  return { db, asyncDb: toAsyncDb(db) };
}

function seedSpace(db: Database, streamDid: StreamDid): void {
  // The space entity + comp_space row are normally created by the
  // JoinSpace materialiser. Tests for the apply machinery seed
  // them directly so we can verify backfilled_to.
  db.run("insert into entities (id, stream_id) values (?, ?)", [
    streamDid,
    streamDid,
  ]);
  db.run("insert into comp_space (entity) values (?)", [streamDid]);
}

function decoded(event: Event, idx: number): DecodedStreamEvent {
  return { event, idx: idx as StreamIndex, user: USER };
}

function createRoomEvent(name: string): Event {
  return {
    $type: "space.roomy.room.createRoom.v0",
    id: newUlid(),
    kind: "space.roomy.channel",
    name,
  } as unknown as Event;
}

/** Seed a channel + thread pair so a createRoomLink can reference both. */
function seedChannelAndThread(
  db: Database,
  channelId: string,
  threadId: string,
): void {
  for (const id of [channelId, threadId]) {
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      id,
      STREAM,
    ]);
  }
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
    [channelId],
  );
  db.run(
    "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.thread', null)",
    [threadId],
  );
}

/**
 * Build a createRoomLink event linking `threadId` into `channelId`.
 * Mirrors what the SDK's createThread / createRoomLink operations emit.
 */
function createRoomLinkEvent(channelId: string, threadId: string): Event {
  return {
    $type: "space.roomy.link.createRoomLink.v0",
    id: newUlid(),
    room: channelId,
    linkToRoom: threadId,
    isCreationLink: true,
  } as unknown as Event;
}

describe("applyBatch", () => {
  test("applies a single event and advances backfilled_to", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const event = createRoomEvent("general");
    const stats = await applyBatch(asyncDb, STREAM, [decoded(event, 5)], {
      isBackfill: true,
    });

    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    const room = await asyncDb
      .query("select entity, label from comp_room where entity = ?")
      .get<{ entity: string; label: string }>(event.id);
    expect(room?.label).toBe("space.roomy.channel");

    const cursor = await asyncDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get<{ backfilled_to: number }>(STREAM);
    expect(cursor?.backfilled_to).toBe(5);
  })

  test("emits structured materialization progress + done telemetry", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    let lines: string[] = [];
    try {
      // 1500 events → chunked at 500, so the ~10% interval log fires for
      // the first two chunks and the done line always fires.
      const events: DecodedStreamEvent[] = [];
      for (let i = 0; i < 1500; i++) {
        events.push(decoded(createRoomEvent(`room-${i}`), i));
      }
      await applyBatch(asyncDb, STREAM, events, { isBackfill: true });
      // Snapshot the captured lines BEFORE restore — mockRestore() wipes
      // the recorded calls.
      lines = infoSpy.mock.calls
        .map((c) => c[0] as string)
        .filter((l) => typeof l === "string" && l.includes('"scope":"materialize"'));
    } finally {
      infoSpy.mockRestore();
    }

    const doneLine = lines
      .map((l) => JSON.parse(l))
      .find((p) => p.msg.includes("done"));
    const progressLine = lines
      .map((l) => JSON.parse(l))
      .find((p) => p.msg.includes("progress"));

    // Progress fires while the batch is mid-flight (done < total).
    expect(progressLine).toBeDefined();
    expect(typeof progressLine.streamId).toBe("string");
    expect(progressLine.total).toBe(1500);
    expect(progressLine.applied).toBeGreaterThan(0);
    expect(typeof progressLine.pct).toBe("number");
    expect(typeof progressLine.isBackfill).toBe("boolean");

    // Done fires once with the final count.
    expect(doneLine).toBeDefined();
    expect(doneLine.streamId).toBe(STREAM);
    expect(doneLine.total).toBe(1500);
    expect(doneLine.applied).toBe(1500);
    expect(doneLine.materializerErrors).toBe(0);
    expect(doneLine.applyErrors).toBe(0);
  })

  test("counts materialiser errors without aborting the batch", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const ok = createRoomEvent("ok");
    const bad = {
      $type: "space.roomy.this.does.not.exist.v0",
      id: newUlid(),
    } as unknown as Event;
    const ok2 = createRoomEvent("ok2");

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [decoded(ok, 1), decoded(bad, 2), decoded(ok2, 3)],
      { isBackfill: true },
    );

    expect(stats.applied).toBe(2);
    expect(stats.materializerErrors).toBe(1);
    expect(stats.applyErrors).toBe(0);
    expect(stats.failed).toHaveLength(1);
    expect(stats.failed[0]?.reason).toBe("materializer");

    expect(
      (await asyncDb
        .query("select count(*) as count from comp_room")
        .get<{ count: number }>())?.count,
    ).toBe(2);

    // Cursor advances to the highest idx in the batch even though one event
    // failed — the failure is tracked, but we have no reason to stay stuck
    // on a permanently-broken event.
    expect(
      (await asyncDb
        .query("select backfilled_to from comp_space where entity = ?")
        .get<{ backfilled_to: number }>(STREAM))?.backfilled_to,
    ).toBe(3);
  })

  test("backfilled_to never moves backwards", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    await applyBatch(asyncDb, STREAM, [decoded(createRoomEvent("a"), 10)], {
      isBackfill: true,
    });
    await applyBatch(asyncDb, STREAM, [decoded(createRoomEvent("b"), 3)], {
      isBackfill: true,
    });

    const cursor = await asyncDb
      .query("select backfilled_to from comp_space where entity = ?")
      .get<{ backfilled_to: number }>(STREAM);
    expect(cursor?.backfilled_to).toBe(10);
  })

  test("empty batch returns zero stats and does not touch cursor", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    db.run("update comp_space set backfilled_to = 7 where entity = ?", [
      STREAM,
    ]);

    const stats = await applyBatch(asyncDb, STREAM, [], { isBackfill: false });

    expect(stats.applied).toBe(0);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    expect(
      (await asyncDb
        .query("select backfilled_to from comp_space where entity = ?")
        .get<{ backfilled_to: number }>(STREAM))?.backfilled_to,
    ).toBe(7);
  })

  test("a single bad SQL error rolls back only that event's savepoint", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const goodA = createRoomEvent("a");
    const goodB = createRoomEvent("b");

    // Drop comp_room mid-batch by hand-applying the first event, then
    // breaking the schema so the second one's INSERT into comp_room fails.
    // We do this via two batches: first batch applies normally, then we
    // break a constraint and fire a second batch.
    await applyBatch(asyncDb, STREAM, [decoded(goodA, 1)], { isBackfill: true });

    // Force a NOT NULL violation by removing comp_room's `entity` column path —
    // simplest deterministic break is a duplicate-pkey: we re-use goodA's id.
    const dup = {
      $type: "space.roomy.room.createRoom.v0",
      id: goodA.id, // same ULID → entities row already exists, comp_room row exists
      kind: "space.roomy.channel",
      name: "dup",
    } as unknown as Event;

    // (this should NOT throw — comp_room insert has `on conflict do nothing`)
    // So we need a different break: violate the default_access CHECK.
    const broken = {
      $type: "space.roomy.room.createRoom.v0",
      id: newUlid(),
      kind: "space.roomy.channel",
      defaultAccess: "bogus", // not in ('readwrite','read','none')
      name: "broken",
    } as unknown as Event;

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [decoded(dup, 2), decoded(broken, 3), decoded(goodB, 4)],
      { isBackfill: true },
    );

    // dup is a no-op (on conflict do nothing), broken should fail apply,
    // goodB should still apply.
    expect(stats.applyErrors).toBeGreaterThanOrEqual(1);
    expect(stats.applied).toBeGreaterThanOrEqual(1);
    expect(
      (await asyncDb
        .query("select name from comp_info where entity = ?")
        .get<{ name: string | null }>(goodB.id))?.name,
    ).toBe("b");

    // The "broken" event must NOT have left an entities row behind — its
    // savepoint should have rolled back.
    expect(
      (await asyncDb
        .query("select count(*) as count from entities where id = ?")
        .get<{ count: number }>(broken.id))?.count,
    ).toBe(0);
  })

  // Regression: the createRoomLink materialiser computes canonical_parent
  // ("first link wins") from the current edge count. With `insert or replace`
  // it was non-idempotent — re-applying the same event flipped
  // canonical_parent 1 → 0, corrupting the parent-channel link for any
  // thread whose stream got re-backfilled. This re-ran on production data
  // and left ~8% of threads orphaned from their channel.
  test("createRoomLink is idempotent under re-application (canonical_parent stays 1)", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    const channelId = newUlid();
    const threadId = newUlid();
    seedChannelAndThread(db, channelId, threadId);

    const link = createRoomLinkEvent(channelId, threadId);

    // First application establishes the link with canonical_parent = 1.
    await applyBatch(asyncDb, STREAM, [decoded(link, 1)], { isBackfill: true });
    const first = await asyncDb
      .query("select payload from edges where label = 'link'")
      .get<{ payload: string }>();
    expect(first?.payload).toBe('{"canonical_parent":1}');

    // Simulate a re-backfill: the same event is delivered and applied again.
    // The materialiser must NOT overwrite the established canonical_parent.
    await applyBatch(asyncDb, STREAM, [decoded(link, 2)], { isBackfill: true });
    await applyBatch(asyncDb, STREAM, [decoded(link, 3)], { isBackfill: true });

    const after = await asyncDb
      .query("select payload from edges where label = 'link'")
      .get<{ payload: string }>();
    expect(after?.payload).toBe('{"canonical_parent":1}');

    // And there is still exactly one link edge (no duplicates).
    const count = (await asyncDb
      .query("select count(*) as n from edges where label = 'link'")
      .get<{ n: number }>())?.n;
    expect(count).toBe(1);
  })

  // Regression: a createRoomLink's system message ("created [thread]") must
  // never be empty. When the acting user has no profile yet (e.g. the Discord
  // bridge bot, which creates threads without a comp_user row), SQLite's ||
  // with a NULL handle operand yields NULL for the whole content expression,
  // materialising an *empty* system message in the parent room. The
  // materialiser must coalesce the author handle (to the DID) and the linked
  // room name so the message is always non-empty and clickable.
  test("createRoomLink system message is non-empty even when the author has no profile", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);
    const channelId = newUlid();
    const threadId = newUlid();
    seedChannelAndThread(db, channelId, threadId);
    db.run("insert into comp_info (entity, name) values (?, ?)", [
      threadId,
      "My Thread",
    ]);

    const link = createRoomLinkEvent(channelId, threadId);

    await applyBatch(asyncDb, STREAM, [decoded(link, 1)], { isBackfill: true });

    // The system message's markdown content must not be NULL. The author is
    // USER (no profile/handle), so it falls back to the DID.
    const row = await asyncDb
      .query("select data, mime_type from comp_content where entity = ?")
      .get<{ data: Uint8Array | null; mime_type: string }>(link.id as unknown as string);
    expect(row?.data).not.toBeNull();
    expect(row?.mime_type).toBe("text/markdown");
    const text = new TextDecoder().decode(row?.data as Uint8Array);
    expect(text).toContain("created [My Thread]");
    expect(text).toContain(USER);
  })

  // The space.joinSpace materialiser must write the `joinedSpace` edge with
  // the *user DID* as head and the space stream as tail — this is what
  // tracks membership. In Phase 3 the appserver routes these membership
  // edges to the global DB, so we pass a globalDb and assert there.
  test("space.joinSpace writes joinedSpace edge with user DID as head", async () => {
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db, STREAM);

    const joinEvent = {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    } as unknown as Event;

    const stats = await applyBatch(
      asyncDb,
      STREAM,
      [{ event: joinEvent, idx: 0 as StreamIndex, user: USER }],
      { isBackfill: true },
      globalDb,
    );

    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    // Edge head must be the user DID, tail the space stream — in the global DB.
    const userEdge = await globalDb
      .query(
        "select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'",
      )
      .get<{ n: number }>(USER, STREAM);
    expect(userEdge?.n).toBe(1);

    // The membership edge must NOT land in the per-space DB.
    const spaceEdge = await asyncDb
      .query(
        "select 1 as n from edges where head = ? and tail = ? and label = 'joinedSpace'",
      )
      .get<{ n: number }>(USER, STREAM);
    expect(spaceEdge?.n).toBeUndefined();
  })

  // Regression: the materialisation path (not just the XRPC fast-path
  // handlers) must write durable membership intent to the read-state DB for
  // LIVE join/leave events. Otherwise a join/leave that reaches applyBatch
  // without a handler write (e.g. a future multi-writer / subscription
  // source) would never update user_space_membership, and getSpaces would
  // silently miss it.
  test("live join/leave events write durable membership intent to the read-state DB", async () => {
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db, STREAM);

    const joinEvent = {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    } as unknown as Event;
    const leaveEvent = {
      $type: "space.roomy.space.leaveSpace.v0",
      id: newUlid(),
    } as unknown as Event;

    // Live join → membership row state 'joined'.
    await applyBatch(
      asyncDb,
      STREAM,
      [{ event: joinEvent, idx: 0 as StreamIndex, user: USER }],
      { isBackfill: false },
      globalDb,
    );
    const readState = openReadStateDb();
    const joined = await readState
      .query(
        "select state, source, source_event_id from user_space_membership where user_did = ? and space_did = ?",
      )
      .get<{ state: string; source: string; source_event_id: string }>(USER, STREAM);
    expect(joined?.state).toBe("joined");
    expect(joined?.source).toBe("space.joinSpace");
    expect(joined?.source_event_id).toBe(joinEvent.id);

    // Live leave → row flips to 'left'.
    await applyBatch(
      asyncDb,
      STREAM,
      [{ event: leaveEvent, idx: 1 as StreamIndex, user: USER }],
      { isBackfill: false },
      globalDb,
    );
    const left = await readState
      .query(
        "select state, source, source_event_id from user_space_membership where user_did = ? and space_did = ?",
      )
      .get<{ state: string; source: string; source_event_id: string }>(USER, STREAM);
    expect(left?.state).toBe("left");
    expect(left?.source).toBe("space.leaveSpace");
    expect(left?.source_event_id).toBe(leaveEvent.id);
  })

  // Backfill/replay must NOT write membership: the boot recovery migration
  // already reduced the full historical log by ULID, and replay events are
  // not guaranteed to arrive in ULID order across streams — writing them
  // could overwrite the correct recovered state with an older event.
  test("backfill join events do not write membership intent", async () => {
    const { db, asyncDb } = freshDb();
    const { asyncDb: globalDb } = freshGlobalDb();
    seedSpace(db, STREAM);

    const joinEvent = {
      $type: "space.roomy.space.joinSpace.v0",
      id: newUlid(),
    } as unknown as Event;
    await applyBatch(
      asyncDb,
      STREAM,
      [{ event: joinEvent, idx: 0 as StreamIndex, user: USER }],
      { isBackfill: true },
      globalDb,
    );

    const readState = openReadStateDb();
    const row = await readState
      .query(
        "select 1 as n from user_space_membership where user_did = ? and space_did = ?",
      )
      .get<{ n: number }>(USER, STREAM);
    expect(row?.n).toBeUndefined();
  })
});

describe("applyBatch — rich-text link detection", () => {
  test("new-format body with a #link facet stores the URL in comp_embed_link", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      channelId,
      STREAM,
    ]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    const url = "https://example.com/richtext";
    const doc = {
      $type: "space.roomy.richtext.document",
      blocks: [
        {
          $type: "space.roomy.richtext.blocks#text",
          text: `check ${url}`,
          facets: [
            {
              index: { byteStart: 6, byteEnd: 6 + url.length },
              features: [{ $type: "space.roomy.richtext.facet#link", uri: url }],
            },
          ],
        },
      ],
    };
    const msgId = newUlid();
    const event = {
      $type: "space.roomy.message.createMessage.v0",
      id: msgId,
      room: channelId,
      body: {
        mimeType: "application/vnd.roomy.richtext+json",
        data: { buf: new TextEncoder().encode(JSON.stringify(doc)) },
      },
      extensions: {},
    } as unknown as Event;

    const stats = await applyBatch(asyncDb, STREAM, [decoded(event, 1)], {
      isBackfill: true,
    });
    expect(stats.applied).toBe(1);
    expect(stats.applyErrors).toBe(0);

    // The facet URL must be stored as an embed link scoped to the message.
    const link = await asyncDb
      .query(
        "select e.room as room from comp_embed_link el join entities e on e.id = el.entity where el.entity = ?",
      )
      .get<{ room: string }>(url);
    expect(link?.room).toBe(msgId);
  });
});

/** Build a createMessage event with a text body in the decoded `{ buf }` form. */
function createMessageEvent(roomId: string, id: string, text: string): Event {
  return {
    $type: "space.roomy.message.createMessage.v0",
    id,
    room: roomId,
    body: {
      mimeType: "text/markdown",
      data: { buf: new TextEncoder().encode(text) },
    },
    extensions: {},
  } as unknown as Event;
}

/** Build a forwardMessages event forwarding one original into `threadId`. */
function forwardMessageEvent(
  threadId: string,
  channelId: string,
  id: string,
  originalId: string,
): Event {
  return {
    $type: "space.roomy.message.forwardMessages.v0",
    id,
    room: threadId,
    messageIds: [originalId],
    fromRoomId: channelId,
  } as unknown as Event;
}

describe("forwardMessages sort order", () => {
  // Regression: forward-reference entities copied the ORIGINAL message's
  // sort_idx, so a forward of an old message was buried deep in the
  // destination room's timeline — outside the first getMessages page (the
  // room query returns the newest `limit` rows). The forward flashed in via
  // the WS diff and vanished on the next refetch. The fix sorts the forward
  // by the forward event's OWN time, so it appears at the top of the
  // destination room, matching the modern forward-as-embed representation.
  test("forwarded messages sort by the forward event's time, not the original's", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    const threadId = newUlid();

    // Two originals in the channel: an OLDER one and a NEWER one (2 min apart).
    const T_old = 1_700_000_000_000;
    const T_new = T_old + 120_000;
    const msgOldId = ulid(T_old);
    const msgNewId = ulid(T_new);
    const msgOld = createMessageEvent(channelId, msgOldId, "old msg");
    const msgNew = createMessageEvent(channelId, msgNewId, "new msg");

    // Forward both into the thread. The forward events are created AFTER the
    // originals (T_fwd > T_new), so both forwards sort above both originals
    // in the thread. Give the NEWER original's forward an EARLIER forward
    // event id than the OLDER original's forward: the forwards must order by
    // their own event times (fwdNew first), NOT by the originals' times
    // (which would put fwdOld first).
    const T_fwd = T_new + 120_000;
    const fwdNewId = ulid(T_fwd); // newer original, earlier forward id
    const fwdOldId = ulid(T_fwd + 5_000); // older original, later forward id
    const fwdNew = forwardMessageEvent(threadId, channelId, fwdNewId, msgNewId);
    const fwdOld = forwardMessageEvent(threadId, channelId, fwdOldId, msgOldId);

    await applyBatch(
      asyncDb,
      STREAM,
      [
        decoded(msgOld, 1),
        decoded(msgNew, 2),
        decoded(fwdNew, 3),
        decoded(fwdOld, 4),
      ],
      { isBackfill: true },
    );

    const { messages } = await selectMessages(asyncDb, {
      kind: "room",
      roomId: threadId,
      limit: 100,
      cursor: null,
    });

    // Ascending: the earlier forward event first, then the later one —
    // regardless of the originals' timestamps. Legacy forward references
    // carry no own content — the original is nested under
    // `forwardedFrom.message` (never substituted into the row).
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe(fwdNewId);
    expect(messages[0]?.content).toBe("");
    expect(messages[0]?.forwardedFrom?.message?.id).toBe(msgNewId);
    expect(messages[0]?.forwardedFrom?.message?.content).toBe("new msg");
    expect(messages[1]?.id).toBe(fwdOldId);
    expect(messages[1]?.content).toBe("");
    expect(messages[1]?.forwardedFrom?.message?.id).toBe(msgOldId);
    expect(messages[1]?.forwardedFrom?.message?.content).toBe("old msg");
  });
})

describe("forward-as-embed (createMessage + forward attachment)", () => {
  // The modern representation of a forward: a `createMessage` event carrying
  // a `space.roomy.attachment.forward.v0` attachment creates a real message in
  // the destination room (with the forwarder's own body) plus a `forward`
  // edge to the original. selectMessages keeps the forwarder's own content
  // and surfaces `forwardedFrom` for the embed.
  test("creates a real message with its own content and a forward edge", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    const threadId = newUlid();
    seedChannelAndThread(db, channelId, threadId);

    const originalId = ulid(1_700_000_000_000);
    const original = createMessageEvent(channelId, originalId, "original text");

    const fwdId = ulid(1_700_000_100_000);
    const fwd: Event = {
      $type: "space.roomy.message.createMessage.v0",
      id: fwdId,
      room: threadId,
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode("my take on this") },
      },
      extensions: {
        "space.roomy.extension.attachments.v0": {
          $type: "space.roomy.extension.attachments.v0",
          attachments: [
            {
              $type: "space.roomy.attachment.forward.v0",
              target: originalId,
              fromRoomId: channelId,
            },
          ],
        },
      },
    } as unknown as Event;

    await applyBatch(
      asyncDb,
      STREAM,
      [decoded(original, 1), decoded(fwd, 2)],
      { isBackfill: true },
    );

    // The forward message keeps its own content and author, and carries a
    // forward edge to the original.
    const edge = await asyncDb
      .query("select tail from edges where head = ? and label = 'forward'")
      .get<{ tail: string }>(fwdId);
    expect(edge?.tail).toBe(originalId);

    const { messages } = await selectMessages(asyncDb, {
      kind: "room",
      roomId: threadId,
      limit: 100,
      cursor: null,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(fwdId);
    expect(messages[0]?.content).toBe("my take on this");
    expect(messages[0]?.forwardedFrom?.messageId).toBe(originalId);
    expect(messages[0]?.forwardedFrom?.roomId).toBe(channelId);
  });
})

// ─── Concurrency: applyBundle savepoint serialization ────────────────────

/**
 * Async DB wrapper that yields to the event loop *before* each operation,
 * simulating the AsyncDatabase worker's per-message interleaving. With
 * `toAsyncDb`, operations execute synchronously before the promise resolves,
 * so concurrent `applyBundle` calls never interleave. This wrapper forces
 * interleaving so the savepoint-mutex fix can be verified.
 */
function yieldingAsyncDb(db: Database): DbLike {
  const toBindings = (...params: unknown[]) => params as SQLQueryBindings[];
  const normaliseRowid = (r: number | bigint | undefined) =>
    r === undefined || r === null ? undefined : Number(r);

  return {
    query(sql: string) {
      const stmt = db.query(sql);
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          await Promise.resolve();
          return stmt.all(...toBindings(...params)) as T[];
        },
        async get<T>(...params: unknown[]): Promise<T | null> {
          await Promise.resolve();
          return (stmt.get(...toBindings(...params)) ?? null) as T | null;
        },
      };
    },
    async prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        async all<T>(...params: unknown[]): Promise<T[]> {
          await Promise.resolve();
          return stmt.all(...toBindings(...params)) as T[];
        },
        async get<T>(...params: unknown[]): Promise<T | null> {
          await Promise.resolve();
          return (stmt.get(...toBindings(...params)) ?? null) as T | null;
        },
        async run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
          await Promise.resolve();
          const result = stmt.run(...toBindings(...params));
          return { changes: result.changes, lastInsertRowid: normaliseRowid(result.lastInsertRowid) };
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await Promise.resolve();
      db.exec(sql);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
      await Promise.resolve();
      const result = (db.run as (...args: unknown[]) => { changes: number; lastInsertRowid?: number | bigint })(sql, ...toBindings(...params));
      return { changes: result.changes, lastInsertRowid: normaliseRowid(result.lastInsertRowid) };
    },
    async transaction<T>(steps: Array<{ type: "query" | "run" | "exec"; sql: string; params?: unknown[] }>): Promise<T> {
      // Simulate worker transaction: yield, then run synchronously
      await Promise.resolve();
      let lastResult: unknown;
      const run = db.transaction(() => {
        for (const step of steps) {
          switch (step.type) {
            case "query":
              lastResult = db.prepare(step.sql).all(...toBindings(...(step.params ?? [])));
              break;
            case "run":
              lastResult = (db.run as (...args: unknown[]) => { changes: number; lastInsertRowid?: number | bigint })(step.sql, ...toBindings(...(step.params ?? [])));
              break;
            case "exec":
              db.exec(step.sql);
              lastResult = undefined;
              break;
          }
        }
      });
      run();
      return lastResult as T;
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

describe("applyBundle concurrency", () => {
  test("concurrent applyBundle calls do not destroy each other's savepoints", async () => {
    const { db } = freshDb();
    seedSpace(db, STREAM);

    // Seed a channel room so createMessage events can reference it.
    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, STREAM]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    const asyncDb = yieldingAsyncDb(db);

    // Two createMessage events with distinct ULIDs — each gets its own
    // savepoint name in applyBundle.
    const eventA = createMessageEvent(channelId, newUlid(), "message A");
    const eventB = createMessageEvent(channelId, newUlid(), "message B");

    // First, materialize the events (insert entities + comp_message rows)
    // so applyBundle's side-effects can find them. We use applyBatch with
    // the synchronous adapter for this setup step.
    const syncDb = toAsyncDb(db);
    await applyBatch(syncDb, STREAM, [decoded(eventA, 1)], { isBackfill: true });
    await applyBatch(syncDb, STREAM, [decoded(eventB, 2)], { isBackfill: true });

    // Now fire two applyBundle calls concurrently with the yielding adapter.
    // Without the mutex, their SAVEPOINT/RELEASE operations interleave:
    // A creates evt_AAA (starts implicit transaction), B creates evt_BBB
    // (nested), A releases evt_AAA (commits, destroys evt_BBB), B fails
    // with "no such savepoint: evt_BBB".
    const bundleA: StatementBundleSuccess = {
      status: "success",
      event: eventA,
      eventIdx: 1 as StreamIndex,
      user: USER,
      statements: [],
      dependsOn: [],
    };
    const bundleB: StatementBundleSuccess = {
      status: "success",
      event: eventB,
      eventIdx: 2 as StreamIndex,
      user: USER,
      statements: [],
      dependsOn: [],
    };

    const results = await Promise.allSettled([
      applyBundle(asyncDb, bundleA, { isBackfill: true, streamId: STREAM }),
      applyBundle(asyncDb, bundleB, { isBackfill: true, streamId: STREAM }),
    ]);

    // Both must succeed — no "no such savepoint" errors.
    for (const [i, result] of results.entries()) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "rejected") {
        // Provide a clear failure message with the actual error.
        throw new Error(`applyBundle ${i} failed: ${result.reason}`);
      }
    }
  });
});

describe("applyBatch concurrency", () => {
  test("concurrent applyBatch calls do not destroy each other's savepoints", async () => {
    const { db } = freshDb();
    seedSpace(db, STREAM);

    // Live batches (isBackfill: false) touch readstate.read_positions for
    // the unread-counter increment, so the readstate schema must be attached
    // (mirrors joinedSpaces.test.ts / dispatcher.test.ts fixtures).
    db.exec("attach database ':memory:' as readstate");
    db.exec(
      "create table if not exists readstate_schema_version (id integer primary key check (id = 1), version text not null) strict",
    );
    db.exec(
      "create table if not exists readstate.read_positions (user_did text not null, room_id text not null, seen_up_to text not null, unread_count integer not null default 0, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
    );
    db.exec(
      "create table if not exists readstate.user_thread_activity (user_did text not null, thread_id text not null, space_did text not null default '', last_active_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, thread_id)) strict",
    );
    db.exec(
      "create table if not exists readstate.user_room_participation (user_did text not null, room_id text not null, last_message_at integer not null, updated_at integer not null default (unixepoch() * 1000), primary key (user_did, room_id)) strict",
    );

    // Seed a channel room so createMessage events can reference it.
    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, STREAM]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );
    const asyncDb = yieldingAsyncDb(db);

    // Two batches racing on the same stream — this is the boot-time
    // re-materialization (backfill) vs a live `sendEvents` write on the same
    // space. Without the shared savepoint mutex, their inline SAVEPOINT /
    // RELEASE operations interleave: A creates evt_AAA (starts the implicit
    // transaction), B creates evt_BBB (nested), A releases evt_AAA (commits,
    // destroying evt_BBB), and B fails with "no such savepoint: evt_BBB".
    const backfillEvents = [
      decoded(createRoomEvent("room-a"), 1),
      decoded(createRoomEvent("room-b"), 2),
      decoded(createRoomEvent("room-c"), 3),
    ];
    const liveEvents = [
      decoded(createMessageEvent(channelId, newUlid(), "live message"), 4),
    ];

    const results = await Promise.allSettled([
      applyBatch(asyncDb, STREAM, backfillEvents, { isBackfill: true }),
      applyBatch(asyncDb, STREAM, liveEvents, { isBackfill: false }),
    ]);

    // Both batches must succeed — no "no such savepoint" errors.
    for (const [i, result] of results.entries()) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "rejected") {
        throw new Error(`applyBatch ${i} failed: ${result.reason}`);
      }
      // The corruption mode: a failed savepoint can leave the surviving
      // call's rows half-committed and its event counted as an apply error
      // while the cursor still advances — silent data loss.
      expect(result.value.applyErrors).toBe(0);
    }

    // And both batches' rows must actually be there (a failed savepoint
    // commits the interleaved partner's partial writes and can drop rows).
    const rooms = await asyncDb
      .query("select count(*) as count from comp_room")
      .get<{ count: number }>();
    // 3 from the backfill batch + the seeded channel room.
    expect(rooms?.count).toBe(4);

    const messages = await asyncDb
      .query("select count(*) as count from entities where room = ?")
      .get<{ count: number }>(channelId);
    expect(messages?.count).toBe(1);

    // Cursor must have advanced past both batches (idx 4 is the last one).
    const cursor = await asyncDb
      .query("select materialized_to from materialization_cursor where stream_id = ?")
      .get<{ materialized_to: number }>(STREAM);
    expect(cursor?.materialized_to).toBe(4);
  });
});

describe("applyBatch — link embed dismissal via editMessage", () => {
  test("a link-only editMessage sets show_preview=0 and hides the embed from selectMessages", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      channelId,
      STREAM,
    ]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    const url = "https://example.com/dismiss";
    const msgId = newUlid();
    const createMsg = {
      $type: "space.roomy.message.createMessage.v0",
      id: msgId,
      room: channelId,
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode(`see ${url}`) },
      },
      extensions: {},
    } as unknown as Event;

    const createStats = await applyBatch(asyncDb, STREAM, [decoded(createMsg, 1)], {
      isBackfill: true,
    });
    expect(createStats.applyErrors).toBe(0);

    // The message starts with a visible link embed.
    const before = await selectMessages(asyncDb, {
      kind: "room",
      roomId: channelId,
      limit: 100,
      cursor: null,
    });
    expect(before.messages[0]?.linkEmbeds.map((l) => l.url)).toContain(url);

    // Author dismisses the embed: an editMessage carrying a link attachment
    // with showPreview:false.
    const editMsg = {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room: channelId,
      messageId: msgId,
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode(`see ${url}`) },
      },
      extensions: {
        "space.roomy.extension.attachments.v0": {
          $type: "space.roomy.extension.attachments.v0",
          attachments: [
            {
              $type: "space.roomy.attachment.link.v0",
              uri: url,
              showPreview: false,
            },
          ],
        },
      },
    } as unknown as Event;

    const editStats = await applyBatch(asyncDb, STREAM, [decoded(editMsg, 2)], {
      isBackfill: true,
    });
    expect(editStats.applyErrors).toBe(0);

    // The link row's show_preview flag is cleared.
    const link = await asyncDb
      .query(
        "select el.show_preview as sp from comp_embed_link el join entities e on e.id = el.entity where e.room = ? and el.entity = ?",
      )
      .get<{ sp: number }>(msgId, url);
    expect(link?.sp).toBe(0);

    // And the read path no longer surfaces the embed.
    const after = await selectMessages(asyncDb, {
      kind: "room",
      roomId: channelId,
      limit: 100,
      cursor: null,
    });
    expect(after.messages[0]?.linkEmbeds.map((l) => l.url)).not.toContain(url);
  });

  test("a link-only editMessage with showPreview:true re-adds a dismissed embed", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      channelId,
      STREAM,
    ]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    const url = "https://example.com/readd";
    const msgId = newUlid();
    const createMsg = {
      $type: "space.roomy.message.createMessage.v0",
      id: msgId,
      room: channelId,
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode(`see ${url}`) },
      },
      extensions: {},
    } as unknown as Event;
    await applyBatch(asyncDb, STREAM, [decoded(createMsg, 1)], {
      isBackfill: true,
    });

    const linkEdit = (showPreview: boolean) =>
      ({
        $type: "space.roomy.message.editMessage.v0",
        id: newUlid(),
        room: channelId,
        messageId: msgId,
        body: {
          mimeType: "text/markdown",
          data: { buf: new TextEncoder().encode(`see ${url}`) },
        },
        extensions: {
          "space.roomy.extension.attachments.v0": {
            $type: "space.roomy.extension.attachments.v0",
            attachments: [
              { $type: "space.roomy.attachment.link.v0", uri: url, showPreview },
            ],
          },
        },
      }) as unknown as Event;

    // Dismiss, then re-add.
    await applyBatch(asyncDb, STREAM, [decoded(linkEdit(false), 2)], {
      isBackfill: true,
    });
    let after = await selectMessages(asyncDb, {
      kind: "room",
      roomId: channelId,
      limit: 100,
      cursor: null,
    });
    expect(after.messages[0]?.linkEmbeds.map((l) => l.url)).not.toContain(url);

    await applyBatch(asyncDb, STREAM, [decoded(linkEdit(true), 3)], {
      isBackfill: true,
    });
    after = await selectMessages(asyncDb, {
      kind: "room",
      roomId: channelId,
      limit: 100,
      cursor: null,
    });
    expect(after.messages[0]?.linkEmbeds.map((l) => l.url)).toContain(url);

    // The link row's show_preview flag is back to 1.
    const link = await asyncDb
      .query(
        "select el.show_preview as sp from comp_embed_link el join entities e on e.id = el.entity where e.room = ? and el.entity = ?",
      )
      .get<{ sp: number }>(msgId, url);
    expect(link?.sp).toBe(1);
  });

  test("a link-only editMessage preserves the message's other attachments", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [
      channelId,
      STREAM,
    ]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    const url = "https://example.com/keep-image";
    const msgId = newUlid();
    const imgUri = "at://img/abc";
    const createMsg = {
      $type: "space.roomy.message.createMessage.v0",
      id: msgId,
      room: channelId,
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode(`see ${url}`) },
      },
      extensions: {
        "space.roomy.extension.attachments.v0": {
          $type: "space.roomy.extension.attachments.v0",
          attachments: [
            {
              $type: "space.roomy.attachment.image.v0",
              uri: imgUri,
              mimeType: "image/png",
              width: 100,
              height: 50,
            },
          ],
        },
      },
    } as unknown as Event;
    await applyBatch(asyncDb, STREAM, [decoded(createMsg, 1)], {
      isBackfill: true,
    });

    // Dismiss the link embed only.
    const editMsg = {
      $type: "space.roomy.message.editMessage.v0",
      id: newUlid(),
      room: channelId,
      messageId: msgId,
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode(`see ${url}`) },
      },
      extensions: {
        "space.roomy.extension.attachments.v0": {
          $type: "space.roomy.extension.attachments.v0",
          attachments: [
            { $type: "space.roomy.attachment.link.v0", uri: url, showPreview: false },
          ],
        },
      },
    } as unknown as Event;
    await applyBatch(asyncDb, STREAM, [decoded(editMsg, 2)], {
      isBackfill: true,
    });

    const after = await selectMessages(asyncDb, {
      kind: "room",
      roomId: channelId,
      limit: 100,
      cursor: null,
    });
    const msg = after.messages[0];
    // The link embed is hidden…
    expect(msg?.linkEmbeds.map((l) => l.url)).not.toContain(url);
    // …but the image attachment is preserved.
    expect(msg?.media.map((m) => m.url)).toContain(imgUri + "?message=" + msgId);
  });
});

describe("applyBatch — activity item canonical timestamps", () => {
  // Regression: bridged messages carry a timestampOverride extension (the
  // original Discord send time), but their ULIDs encode bridge-ingestion
  // time. The activity_item upsert used the ULID time, so getThreads /
  // getActivityFeed ordered bridged threads by ingestion order — which for a
  // backfill is reverse Discord-chronological (rooms created in backfill
  // order, messages ingested oldest-first per channel). The upsert must use
  // the canonical timestamp for last_activity_at and the window entries.
  test("bridged messages order activity by Discord time, not ULID time", async () => {
    const { db, asyncDb } = freshDb();
    seedSpace(db, STREAM);

    const channelId = newUlid();
    db.run("insert into entities (id, stream_id) values (?, ?)", [channelId, STREAM]);
    db.run(
      "insert into comp_room (entity, label, default_access) values (?, 'space.roomy.channel', 'readwrite')",
      [channelId],
    );

    // ULID times: msg1 ingested AFTER msg2 (bridge processed msg2 first).
    const ingestTs1 = 1_717_536_100_000;
    const ingestTs2 = 1_717_536_000_000;
    // Discord times: msg1 is OLDER than msg2.
    const discordTs1 = 1_700_000_000_000;
    const discordTs2 = 1_700_000_100_000;

    const bridgedMessage = (id: string, discordTs: number, text: string): Event =>
      ({
        $type: "space.roomy.message.createMessage.v0",
        id,
        room: channelId,
        body: {
          mimeType: "text/markdown",
          data: { buf: new TextEncoder().encode(text) },
        },
        extensions: {
          "space.roomy.extension.timestampOverride.v0": {
            $type: "space.roomy.extension.timestampOverride.v0",
            timestamp: discordTs,
          },
        },
      }) as unknown as Event;

    const msg1 = ulid(ingestTs1);
    const msg2 = ulid(ingestTs2);

    await applyBatch(
      asyncDb,
      STREAM,
      [
        decoded(bridgedMessage(msg1, discordTs1, "older discord msg"), 1),
        decoded(bridgedMessage(msg2, discordTs2, "newer discord msg"), 2),
      ],
      { isBackfill: true },
    );

    const row = await asyncDb
      .query("select last_activity_at, recent_message_ids from activity_item where room_id = ?")
      .get<{ last_activity_at: number; recent_message_ids: string }>(channelId);

    expect(row).not.toBeNull();
    // last_activity_at is the newest DISCORD time, not the newest ULID time.
    expect(row!.last_activity_at).toBe(discordTs2);
    const stored: Array<{ id: string; ts: number }> = JSON.parse(row!.recent_message_ids);
    // Newest by canonical time first — msg2 (newer Discord time) ahead of
    // msg1 even though msg1 was ingested later.
    expect(stored[0]!.id).toBe(msg2);
    expect(stored[0]!.ts).toBe(discordTs2);
    expect(stored[1]!.id).toBe(msg1);
    expect(stored[1]!.ts).toBe(discordTs1);
  });
});
