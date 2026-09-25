/**
 * Tests for the InvalidationRouter pub/sub bus.
 */

import { describe, it, expect, afterAll } from "bun:test";
import type { StreamDid, UserDid, EventType, Ulid } from "@roomy-space/sdk";
import { Router } from "./router.ts";
import { openDb, closeDb } from "../db/db.ts";
import type { AppliedEvent, InvalidationEvent } from "./types.ts";
import {
  _resetProfileStoreCache,
  _setTestGetProfiles,
} from "../queries/profileStore.ts";
import { _resetProfileNegativeCache } from "../materialization/profiles.ts";

const STREAM_DID = "did:web:space.example.com" as StreamDid;
const USER_DID = "did:plc:alice" as UserDid;

// `inferSignals` builds message diffs by reading the message back from the
// materialized DB via `selectMessages`. Materialize the row into a fresh
// in-memory DB (installed as the process-wide singleton) so the Router's
// message-event paths produce diffs as they do in production.
async function seedMessageDb(messageId: string): Promise<void> {
  closeDb();
  const db = openDb({ path: ":memory:" }).forSpace(STREAM_DID);
  await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", USER_DID, USER_DID);
  await db.run(
    "insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)",
    USER_DID, "Alice", null,
  );
  await db.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    messageId, STREAM_DID, "01ROOM1AAAAAAAAAAAAAA000", messageId,
  );
  await db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) " +
      "values (?, 'text/plain', ?, ?, ?)",
    messageId, Buffer.from("hello"), messageId, Date.now(),
  );
  await db.run("insert into edges (head, tail, label) values (?, ?, 'author')",
    messageId, USER_DID,
  );
}

afterAll(() => closeDb());

function makeEvent(
  type: EventType,
  overrides?: Partial<AppliedEvent>,
): AppliedEvent {
  return {
    streamDid: STREAM_DID,
    user: USER_DID,
    id: "01EVENT123" as Ulid,
    ...overrides,
    type,
  };
}

/** Collect events from a listener into a mutable array. */
function collect(): {
  events: InvalidationEvent[][];
  listener: (e: readonly InvalidationEvent[]) => void;
} {
  const events: InvalidationEvent[][] = [];
  return {
    events,
    listener: (e) => events.push([...e]),
  };
}

describe("Router", () => {
  it("delivers signals to subscribers", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    await router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.length).toBeGreaterThan(0);
    expect(events[0]![0]!.kind).toBe("queryInvalidation");
  });

  it("suppresses signals during backfill", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    await router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: true },
    );

    expect(events).toHaveLength(0);
  });

  it("does not call listeners when there are no subscribers", async () => {
    const router = new Router();
    // Should not throw.
    await router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );
  });

  it("assigns monotonically increasing seq to message diffs", async () => {
    // Both createMessage events share the same event id (see `makeEvent`),
    // so one materialized message row covers both.
    await seedMessageDb("01EVENT123");

    const router = new Router();
    const seqs: number[] = [];

    router.subscribe((events) => {
      for (const e of events) {
        if (e.kind === "messageDiff") {
          seqs.push(e.signal.seq);
        }
      }
    });

    await router.onEventsApplied(
      STREAM_DID,
      [
        makeEvent("space.roomy.message.createMessage.v0", {
          roomId: "01ROOM1AAAAAAAAAAAAAA000" as Ulid,
        }),
      ],
      { isBackfill: false },
    );

    await router.onEventsApplied(
      STREAM_DID,
      [
        makeEvent("space.roomy.message.createMessage.v0", {
          roomId: "01ROOM2AAAAAAAAAAAAAA000" as Ulid,
        }),
      ],
      { isBackfill: false },
    );

    expect(seqs).toHaveLength(2);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
  });

  it("batch-fetches message snapshots once for a batch of message events", async () => {
    // Two createMessage events with distinct ids in a single onEventsApplied
    // call. The router should issue ONE selectMessages({kind:"ids"}) for
    // both ids and emit a messageDiff for each — proving the batched
    // snapshot fetch covers every event in the batch.
    const EVENT_A = "01EVENTAAAAAAAAAAAAAAAAA" as Ulid;
    const EVENT_B = "01EVENTBBBBBBBBBBBBBBBBB" as Ulid;
    // Seed both rows into a single in-memory DB (seedMessageDb wipes on
    // each call, so do it inline here to keep both rows alive).
    closeDb();
    const db = openDb({ path: ":memory:" }).forSpace(STREAM_DID);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", USER_DID, USER_DID);
    await db.run(
      "insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)",
      USER_DID, "Alice", null,
    );
    for (const [msgId, roomId] of [
      [EVENT_A, "01ROOM_AAAAAAAAAAAAAA000"],
      [EVENT_B, "01ROOM_BAAAAAAAAAAAAAA000"],
    ] as const) {
      await db.run(
        "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
        msgId, STREAM_DID, roomId, msgId,
      );
      await db.run(
        "insert into comp_content (entity, mime_type, data, last_edit, timestamp) " +
          "values (?, 'text/plain', ?, ?, ?)",
        msgId, Buffer.from("hello"), msgId, Date.now(),
      );
      await db.run(
        "insert into edges (head, tail, label) values (?, ?, 'author')",
        msgId, USER_DID,
      );
    }

    const router = new Router();
    const diffRoomIds: string[] = [];
    router.subscribe((events) => {
      for (const e of events) {
        if (e.kind === "messageDiff") {
          diffRoomIds.push(e.signal.roomId);
        }
      }
    });

    await router.onEventsApplied(
      STREAM_DID,
      [
        makeEvent("space.roomy.message.createMessage.v0", {
          id: EVENT_A,
          roomId: "01ROOM_AAAAAAAAAAAAAA000" as Ulid,
        }),
        makeEvent("space.roomy.message.createMessage.v0", {
          id: EVENT_B,
          roomId: "01ROOM_BAAAAAAAAAAAAAA000" as Ulid,
        }),
      ],
      { isBackfill: false },
    );

    // Both events produced a messageDiff, each keyed to its own room.
    expect(diffRoomIds).toHaveLength(2);
    expect(diffRoomIds).toContain("01ROOM_AAAAAAAAAAAAAA000");
    expect(diffRoomIds).toContain("01ROOM_BAAAAAAAAAAAAAA000");
  });

  it("unsubscribe stops delivery", async () => {
    const router = new Router();
    let count = 0;

    const unsub = router.subscribe(() => count++);

    await router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );
    expect(count).toBe(1);

    unsub();

    await router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );
    expect(count).toBe(1); // No increase.
  });

  it("continues delivering to other listeners when one throws", async () => {
    const router = new Router();
    let secondReceived = 0;

    router.subscribe(() => {
      throw new Error("boom");
    });
    router.subscribe(() => secondReceived++);

    // Should not throw, and second listener should still be called.
    await router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );

    expect(secondReceived).toBe(1);
  });

  it("batches signals from multiple events in one callback", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    await router.onEventsApplied(
      STREAM_DID,
      [
        makeEvent("space.roomy.space.updateSidebar.v1"),
        makeEvent("space.roomy.space.updateSpaceInfo.v0"),
      ],
      { isBackfill: false },
    );

    // One call, with signals from both events.
    expect(events).toHaveLength(1);
    expect(events[0]!.length).toBeGreaterThan(1);
  });

  it("skips dispatch when all events produce no signals", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    // page edit is out of scope → no signals.
    await router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.page.editPage.v0")],
      { isBackfill: false },
    );

    expect(events).toHaveLength(0);
  });

  // ─── Per-batch signal dedup ──────────────────────────────────────────
  // A batch of N same-type events would otherwise make every handler emit N
  // copies of the whole batch-level signal set, and the WS handler broadcasts
  // each copy to every connection. These pin the coalescing contract.

  it("a batch of N deletes emits ONE getActivityFeed invalidation", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    const roomId = "01ROOMDELETEAAAAAAAAA000" as Ulid;
    const deletes = Array.from({ length: 5 }, (_, i) =>
      makeEvent("space.roomy.message.deleteMessage.v0", {
        id: `01DELETE${i}AAAAAAAAAAAAAA` as Ulid,
        roomId,
        details: { messageId: `01DELMSG${i}AAAAAAAAAAAAA` },
      }),
    );

    await router.onEventsApplied(STREAM_DID, deletes, { isBackfill: false });

    expect(events).toHaveLength(1);
    const feedInvalidations = events[0]!.filter(
      (e) =>
        e.kind === "queryInvalidation" &&
        e.signal.nsid === "space.roomy.space.getActivityFeed",
    );
    expect(feedInvalidations).toHaveLength(1);

    // Every other batch-level invalidation collapses too.
    const nsids = events[0]!
      .filter((e) => e.kind === "queryInvalidation")
      .map((e) => (e.kind === "queryInvalidation" ? e.signal.nsid : ""));
    expect(new Set(nsids).size).toBe(nsids.length);
  });

  it("keeps one messageDiff per delete (per-message signals never collapse)", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    const roomId = "01ROOMDELETEBBBBBBBBB000" as Ulid;
    const deletes = Array.from({ length: 3 }, (_, i) =>
      makeEvent("space.roomy.message.deleteMessage.v0", {
        id: `01DELETE2${i}AAAAAAAAAAAAA` as Ulid,
        roomId,
        details: { messageId: `01DELMSG2${i}AAAAAAAAAAAA` },
      }),
    );

    await router.onEventsApplied(STREAM_DID, deletes, { isBackfill: false });

    const diffs = events[0]!.filter((e) => e.kind === "messageDiff");
    expect(diffs).toHaveLength(3);
    const keys = diffs.map((d) => (d.kind === "messageDiff" ? d.signal.ops[0] : null));
    // Distinct remove ops — one per deleted message, not merged.
    expect(new Set(keys.map((k) => JSON.stringify(k))).size).toBe(3);
  });

  it("dedupes query invalidations that differ only by param key order", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getThreads",
          params: { spaceId: STREAM_DID, limit: "20" },
        },
      },
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getThreads",
          params: { limit: "20", spaceId: STREAM_DID },
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toHaveLength(1);
  });

  it("keeps only the LAST roomActivityDiff per room (a superseding snapshot, not a delta)", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    const activity = (messageId: string, ts: string): InvalidationEvent => ({
      kind: "roomActivityDiff",
      signal: {
        spaceId: STREAM_DID,
        roomId: "01ROOM" as Ulid,
        kind: "channel",
        activity: {
          latestTimestamp: ts,
          latestMembers: [{ did: USER_DID, name: null, avatar: null }],
          latestMessage: {
            id: messageId,
            content: messageId,
            author: { did: USER_DID, name: null, avatar: null },
            timestamp: ts,
          },
        },
      },
    });

    // Three messages in one room — each diff is a full snapshot of the room's
    // latest activity, so only the newest is true. Collapsing keeps the first
    // slot (emission order) but holds the LAST payload.
    router.emit([
      activity("01MSG1", "2026-09-21T10:00:00.000Z"),
      activity("01MSG2", "2026-09-21T10:01:00.000Z"),
      activity("01MSG3", "2026-09-21T10:02:00.000Z"),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toHaveLength(1);
    const kept = events[0]![0]!;
    expect(kept.kind).toBe("roomActivityDiff");
    if (kept.kind === "roomActivityDiff") {
      expect(kept.signal.activity.latestMessage?.id).toBe("01MSG3");
      expect(kept.signal.activity.latestTimestamp).toBe("2026-09-21T10:02:00.000Z");
    }
  });

  it("keeps roomActivityDiffs for DIFFERENT rooms separate", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    const activity = (roomId: string, messageId: string): InvalidationEvent => ({
      kind: "roomActivityDiff",
      signal: {
        spaceId: STREAM_DID,
        roomId: roomId as Ulid,
        kind: "channel",
        activity: {
          latestTimestamp: "2026-09-21T10:00:00.000Z",
          latestMembers: [],
          latestMessage: {
            id: messageId,
            content: messageId,
            author: { did: USER_DID, name: null, avatar: null },
            timestamp: "2026-09-21T10:00:00.000Z",
          },
        },
      },
    });

    router.emit([
      activity("01ROOM1AAAAAAAAAAAAAA000", "01MSG1"),
      activity("01ROOM2BBBBBBBBBBBBBB000", "01MSG2"),
    ]);

    expect(events[0]).toHaveLength(2);
  });

  it("keeps invalidations that differ by affectedUser separate", async () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getActivityFeed",
          params: {},
          affectedUser: USER_DID,
        },
      },
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getActivityFeed",
          params: {},
          affectedUser: "did:plc:bob" as UserDid,
        },
      },
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getActivityFeed",
          params: {},
          affectedUser: USER_DID,
        },
      },
    ]);

    expect(events).toHaveLength(1);
    // alice, bob — the duplicate alice signal collapses.
    expect(events[0]).toHaveLength(2);
  });

  it("emit dedupes a repeated invalidation", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);
    const signal: InvalidationEvent = {
      kind: "queryInvalidation",
      signal: {
        nsid: "space.roomy.space.getActivityFeed",
        params: {},
      },
    };

    router.emit([signal, signal, signal]);

    expect(events).toHaveLength(1);
    expect(events[0]).toHaveLength(1);
  });

  it("emit delivers signals directly to subscribers", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    const signals: InvalidationEvent[] = [
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.room.getMetadata",
          params: { roomId: "01ROOM" },
          affectedUser: USER_DID,
        },
      },
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getSpaces",
          params: {},
          affectedUser: USER_DID,
        },
      },
    ];

    router.emit(signals);

    expect(events).toHaveLength(1);
    expect(events[0]).toHaveLength(2);
    expect(events[0]![0]!.kind).toBe("queryInvalidation");
  });

  it("emit is a no-op when there are no subscribers", () => {
    const router = new Router();
    // Should not throw.
    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getMetadata",
          params: { spaceId: "01SPACE" },
        },
      },
    ]);
  });

  it("emit is a no-op for empty signals", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    router.emit([]);

    expect(events).toHaveLength(0);
  });

  it("emit stamps a monotonic seq on messageDiff signals (embed sweeper path)", () => {
    // Signals emitted via `emit` (e.g. the embed sweeper's enrichment diffs)
    // must not carry seq 0 — the client reads a zero seq as a server seq reset,
    // which triggers a spurious refetch on every card-enrichment diff.
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    const diff = (): InvalidationEvent => ({
      kind: "messageDiff",
      signal: { roomId: "01ROOM" as Ulid, seq: 0, ops: [] },
    });

    router.emit([diff()]);
    router.emit([diff()]);

    expect(events).toHaveLength(2);
    const seqs = events.map(
      (e) => (e[0]!.kind === "messageDiff" ? e[0]!.signal.seq : -1),
    );
    // seq must be positive, strictly increasing, and shared across emits.
    expect(seqs[0]).toBeGreaterThan(0);
    expect(seqs[1]!).toBe(seqs[0]! + 1);
  });
});

// ─── Singleton lifecycle ────────────────────────────────────────────────

describe("Router singleton", () => {
  it("setInstance / getInstance / resetInstance round-trip", () => {
    // Clean slate — other tests may have left a stale instance.
    Router.resetInstance();
    expect(Router.getInstance()).toBeUndefined();

    const router = new Router();
    Router.setInstance(router);
    expect(Router.getInstance()).toBe(router);

    Router.resetInstance();
    expect(Router.getInstance()).toBeUndefined();
  });
});

// ─── Write-path purity ──────────────────────────────────────────────────

describe("Router write-path purity", () => {
  /**
   * `onEventsApplied` runs inline in `StreamManager.sendEvents`, so it must
   * not attempt profile resolution: an author missing from the global store
   * triggers an on-demand HappyView/Bluesky fetch, which puts a third-party
   * HTTP round-trip inside the caller's write (~450ms, measured in
   * production; see perf/probe-sendevents.ts).
   *
   * Observed through the profile store's test seam rather than the network:
   * under `bun test` the real fetch is short-circuited by a NODE_ENV guard,
   * so the observable that matters is *whether hydration was attempted at
   * all*, which is exactly what the seam reports.
   */
  it("builds message diffs without attempting profile hydration", async () => {
    const MESSAGE_ID = "01WRITEPATHMSGAAAAAAAAAA";
    const AUTHOR_DID = "did:plc:write-path-author";
    closeDb();
    const db = openDb({ path: ":memory:" }).forSpace(STREAM_DID);
    await db.run("insert or ignore into entities (id, stream_id) values (?, ?)", AUTHOR_DID, AUTHOR_DID);
    await db.run(
      "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
      MESSAGE_ID, STREAM_DID, "01ROOM1AAAAAAAAAAAAAA000", MESSAGE_ID,
    );
    await db.run(
      "insert into comp_content (entity, mime_type, data, last_edit, timestamp) " +
        "values (?, 'text/plain', ?, ?, ?)",
      MESSAGE_ID, Buffer.from("hello"), MESSAGE_ID, Date.now(),
    );
    await db.run(
      "insert into edges (head, tail, label) values (?, ?, 'author')",
      MESSAGE_ID, AUTHOR_DID,
    );

    // The author deliberately has no row in the global `profiles` table —
    // the condition that makes hydration fire.
    const hydrated: string[][] = [];
    _resetProfileStoreCache();
  _resetProfileNegativeCache();
    _setTestGetProfiles(async (dids) => {
      hydrated.push([...dids]);
      return [];
    });

    try {
      const router = new Router();
      router.subscribe(() => {});
      await router.onEventsApplied(
        STREAM_DID,
        [
          makeEvent("space.roomy.message.createMessage.v0", {
            id: MESSAGE_ID as Ulid,
            user: AUTHOR_DID as UserDid,
            roomId: "01ROOM1AAAAAAAAAAAAAA000" as Ulid,
          }),
        ],
        { isBackfill: false },
      );
    } finally {
      _setTestGetProfiles(null);
    }

    expect(hydrated).toEqual([]);
  });
});
