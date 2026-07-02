import { describe, expect, test } from "bun:test";
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

import { openDb } from "../db/db.ts";
import { attachInMemoryReadState } from "../db/readStateDb.ts";
import { applyBatch } from "./applyBatch.ts";
import { selectMessages } from "../queries/selectMessages.ts";

const STREAM = StreamDid.assert("did:web:test-stream.example");
const USER = UserDid.assert("did:plc:test-user");

function freshDb(): Database {
  return openDb({ path: ":memory:", isolated: true });
}

function seedSpace(db: Database, streamDid: StreamDid): void {
  // The space entity + comp_space row are normally created by the
  // PersonalJoinSpace materialiser on the user's personal stream. Tests for
  // the apply machinery seed them directly so we can verify backfilled_to.
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
  test("applies a single event and advances backfilled_to", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    const event = createRoomEvent("general");
    const stats = applyBatch(db, STREAM, [decoded(event, 5)], {
      isBackfill: true,
    });

    expect(stats.applied).toBe(1);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    const room = db
      .query<
        { entity: string; label: string },
        [string]
      >("select entity, label from comp_room where entity = ?")
      .get(event.id);
    expect(room?.label).toBe("space.roomy.channel");

    const cursor = db
      .query<
        { backfilled_to: number },
        [string]
      >("select backfilled_to from comp_space where entity = ?")
      .get(STREAM);
    expect(cursor?.backfilled_to).toBe(5);
  });

  test("counts materialiser errors without aborting the batch", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    const ok = createRoomEvent("ok");
    const bad = {
      $type: "space.roomy.this.does.not.exist.v0",
      id: newUlid(),
    } as unknown as Event;
    const ok2 = createRoomEvent("ok2");

    const stats = applyBatch(
      db,
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
      db
        .query<{ count: number }, []>("select count(*) as count from comp_room")
        .get()?.count,
    ).toBe(2);

    // Cursor advances to the highest idx in the batch even though one event
    // failed — the failure is tracked, but we have no reason to stay stuck
    // on a permanently-broken event.
    expect(
      db
        .query<
          { backfilled_to: number },
          [string]
        >("select backfilled_to from comp_space where entity = ?")
        .get(STREAM)?.backfilled_to,
    ).toBe(3);
  });

  test("backfilled_to never moves backwards", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    applyBatch(db, STREAM, [decoded(createRoomEvent("a"), 10)], {
      isBackfill: true,
    });
    applyBatch(db, STREAM, [decoded(createRoomEvent("b"), 3)], {
      isBackfill: true,
    });

    const cursor = db
      .query<
        { backfilled_to: number },
        [string]
      >("select backfilled_to from comp_space where entity = ?")
      .get(STREAM);
    expect(cursor?.backfilled_to).toBe(10);
  });

  test("empty batch returns zero stats and does not touch cursor", () => {
    const db = freshDb();
    seedSpace(db, STREAM);
    db.run("update comp_space set backfilled_to = 7 where entity = ?", [
      STREAM,
    ]);

    const stats = applyBatch(db, STREAM, [], { isBackfill: false });

    expect(stats.applied).toBe(0);
    expect(stats.materializerErrors).toBe(0);
    expect(stats.applyErrors).toBe(0);

    expect(
      db
        .query<
          { backfilled_to: number },
          [string]
        >("select backfilled_to from comp_space where entity = ?")
        .get(STREAM)?.backfilled_to,
    ).toBe(7);
  });

  test("a single bad SQL error rolls back only that event's savepoint", () => {
    const db = freshDb();
    seedSpace(db, STREAM);

    const goodA = createRoomEvent("a");
    const goodB = createRoomEvent("b");

    // Drop comp_room mid-batch by hand-applying the first event, then
    // breaking the schema so the second one's INSERT into comp_room fails.
    // We do this via two batches: first batch applies normally, then we
    // break a constraint and fire a second batch.
    applyBatch(db, STREAM, [decoded(goodA, 1)], { isBackfill: true });

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

    const stats = applyBatch(
      db,
      STREAM,
      [decoded(dup, 2), decoded(broken, 3), decoded(goodB, 4)],
      { isBackfill: true },
    );

    // dup is a no-op (on conflict do nothing), broken should fail apply,
    // goodB should still apply.
    expect(stats.applyErrors).toBeGreaterThanOrEqual(1);
    expect(stats.applied).toBeGreaterThanOrEqual(1);
    expect(
      db
        .query<
          { name: string | null },
          [string]
        >("select name from comp_info where entity = ?")
        .get(goodB.id)?.name,
    ).toBe("b");

    // The "broken" event must NOT have left an entities row behind — its
    // savepoint should have rolled back.
    expect(
      db
        .query<
          { count: number },
          [string]
        >("select count(*) as count from entities where id = ?")
        .get(broken.id)?.count,
    ).toBe(0);
  });

  // Regression: the createRoomLink materialiser computes canonical_parent
  // ("first link wins") from the current edge count. With `insert or replace`
  // it was non-idempotent — re-applying the same event flipped
  // canonical_parent 1 → 0, corrupting the parent-channel link for any
  // thread whose stream got re-backfilled. This re-ran on production data
  // and left ~8% of threads orphaned from their channel.
  test("createRoomLink is idempotent under re-application (canonical_parent stays 1)", () => {
    const db = freshDb();
    seedSpace(db, STREAM);
    const channelId = newUlid();
    const threadId = newUlid();
    seedChannelAndThread(db, channelId, threadId);

    const link = createRoomLinkEvent(channelId, threadId);

    // First application establishes the link with canonical_parent = 1.
    applyBatch(db, STREAM, [decoded(link, 1)], { isBackfill: true });
    const first = db
      .query<{ payload: string }, []>(
        "select payload from edges where label = 'link'",
      )
      .get();
    expect(first?.payload).toBe('{"canonical_parent":1}');

    // Simulate a re-backfill: the same event is delivered and applied again.
    // The materialiser must NOT overwrite the established canonical_parent.
    applyBatch(db, STREAM, [decoded(link, 2)], { isBackfill: true });
    applyBatch(db, STREAM, [decoded(link, 3)], { isBackfill: true });

    const after = db
      .query<{ payload: string }, []>(
        "select payload from edges where label = 'link'",
      )
      .get();
    expect(after?.payload).toBe('{"canonical_parent":1}');

    // And there is still exactly one link edge (no duplicates).
    const count = db
      .query<{ n: number }, []>(
        "select count(*) as n from edges where label = 'link'",
      )
      .get()?.n;
    expect(count).toBe(1);
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
  // Regression: forward-reference entities got no sort_idx, so selectMessages
  // fell back to ordering by the forward event's own ULID. A thread-creation
  // batch forwards several messages within the same millisecond, so those
  // ULIDs differ only in their random suffixes and the original chronological
  // order of the forwarded messages was scrambled (older forwarded messages
  // could appear after newer ones). The fix copies the original message's
  // sort_idx onto the forward-reference entity.
  test("forwarded messages sort by the original's timestamp, not the forward event's", () => {
    const db = freshDb();
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

    // Forward both into the thread. To reproduce the pre-fix scramble
    // deterministically, give the NEWER original's forward an EARLIER forward
    // event id than the OLDER original's forward. Before the fix the forward
    // references sorted by event id, so the newer-original forward would come
    // first (older-after-newer). After the fix they sort by the originals'
    // sort_idx, restoring chronological order.
    const T_fwd = T_new + 120_000;
    const fwdNewId = ulid(T_fwd); // newer original, earlier forward id
    const fwdOldId = ulid(T_fwd + 5_000); // older original, later forward id
    const fwdNew = forwardMessageEvent(threadId, channelId, fwdNewId, msgNewId);
    const fwdOld = forwardMessageEvent(threadId, channelId, fwdOldId, msgOldId);

    applyBatch(
      db,
      STREAM,
      [
        decoded(msgOld, 1),
        decoded(msgNew, 2),
        decoded(fwdNew, 3),
        decoded(fwdOld, 4),
      ],
      { isBackfill: true },
    );

    const { messages } = selectMessages(db, {
      kind: "room",
      roomId: threadId,
      limit: 100,
      cursor: null,
    });

    // Ascending: the older original's forward first, then the newer's.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe(fwdOldId);
    expect(messages[0]?.content).toBe("old msg");
    expect(messages[1]?.id).toBe(fwdNewId);
    expect(messages[1]?.content).toBe("new msg");
  });
});

describe("user_room_participation tracking (Phase 2)", () => {
  test("live createMessage upserts the author's participation; backfill does not", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedSpace(db, STREAM);
    const channelId = newUlid();

    const T = 1_700_000_000_000;
    const msgId = ulid(T);
    const msg = createMessageEvent(channelId, msgId, "hello");

    // Live: should upsert participation for (USER, channelId) at the message
    // timestamp (decoded from the ULID).
    const stats = applyBatch(db, STREAM, [decoded(msg, 1)], {
      isBackfill: false,
    });
    expect(stats.applyErrors).toBe(0);
    expect(stats.applied).toBe(1);

    const row = db
      .query<{ last_message_at: number }, [string, string]>(
        "select last_message_at from readstate.user_room_participation where user_did = ? and room_id = ?",
      )
      .get(USER, channelId);
    expect(row?.last_message_at).toBe(T);

    // Backfill message by a different user must NOT create a participation
    // row (the gate is `!isBackfill`, matching the unread-counter increment).
    const otherUser = UserDid.assert("did:plc:other-user");
    const T2 = T + 60_000;
    const backfillMsg = createMessageEvent(channelId, ulid(T2), "backfilled");
    const bfStats = applyBatch(
      db,
      STREAM,
      [{ event: backfillMsg, idx: 2 as StreamIndex, user: otherUser }],
      { isBackfill: true },
    );
    expect(bfStats.applyErrors).toBe(0);
    const otherRow = db
      .query<{ n: number }, [string, string]>(
        "select 1 as n from readstate.user_room_participation where user_did = ? and room_id = ?",
      )
      .get(otherUser, channelId);
    expect(otherRow).toBeNull();
  });

  test("authorOverride extension routes participation to the override author", () => {
    const db = freshDb();
    attachInMemoryReadState(db);
    seedSpace(db, STREAM);
    const channelId = newUlid();
    const overrideDid = "did:plc:bridged-author";

    const T = 1_700_000_000_000;
    const msg = {
      $type: "space.roomy.message.createMessage.v0",
      id: ulid(T),
      room: channelId,
      body: {
        mimeType: "text/markdown",
        data: { buf: new TextEncoder().encode("bridged") },
      },
      extensions: {
        "space.roomy.extension.authorOverride.v0": { did: overrideDid },
      },
    } as unknown as Event;

    // The stream `user` is USER, but the override author should get the row.
    applyBatch(db, STREAM, [decoded(msg, 1)], { isBackfill: false });

    const streamUserRow = db
      .query<{ n: number }, [string, string]>(
        "select 1 as n from readstate.user_room_participation where user_did = ? and room_id = ?",
      )
      .get(USER, channelId);
    expect(streamUserRow).toBeNull();

    const overrideRow = db
      .query<{ last_message_at: number }, [string, string]>(
        "select last_message_at from readstate.user_room_participation where user_did = ? and room_id = ?",
      )
      .get(overrideDid, channelId);
    expect(overrideRow?.last_message_at).toBe(T);
  });
});
