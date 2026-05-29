/**
 * Tests for the InvalidationRouter pub/sub bus.
 */

import { describe, it, expect, afterAll } from "bun:test";
import type { StreamDid, UserDid, EventType, Ulid } from "@roomy-space/sdk";
import { Router } from "./router.ts";
import { openDb, closeDb } from "../db/db.ts";
import type { AppliedEvent, InvalidationEvent } from "./types.ts";

const STREAM_DID = "did:web:space.example.com" as StreamDid;
const USER_DID = "did:plc:alice" as UserDid;

// `inferSignals` builds message diffs by reading the message back from the
// materialized DB via `selectMessages`. Materialize the row into a fresh
// in-memory DB (installed as the process-wide singleton) so the Router's
// message-event paths produce diffs as they do in production.
function seedMessageDb(messageId: string): void {
  closeDb();
  const db = openDb({ path: ":memory:" });
  db.run("insert or ignore into entities (id, stream_id) values (?, ?)", [
    USER_DID,
    USER_DID,
  ]);
  db.run(
    "insert or ignore into comp_info (entity, name, avatar) values (?, ?, ?)",
    [USER_DID, "Alice", null],
  );
  db.run(
    "insert into entities (id, stream_id, room, sort_idx) values (?, ?, ?, ?)",
    [messageId, STREAM_DID, "01ROOM1AAAAAAAAAAAAAA000", messageId],
  );
  db.run(
    "insert into comp_content (entity, mime_type, data, last_edit, timestamp) " +
      "values (?, 'text/plain', ?, ?, ?)",
    [messageId, Buffer.from("hello"), messageId, Date.now()],
  );
  db.run("insert into edges (head, tail, label) values (?, ?, 'author')", [
    messageId,
    USER_DID,
  ]);
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
  it("delivers signals to subscribers", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.length).toBeGreaterThan(0);
    expect(events[0]![0]!.kind).toBe("queryInvalidation");
  });

  it("suppresses signals during backfill", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: true },
    );

    expect(events).toHaveLength(0);
  });

  it("does not call listeners when there are no subscribers", () => {
    const router = new Router();
    // Should not throw.
    router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );
  });

  it("assigns monotonically increasing seq to message diffs", () => {
    // Both createMessage events share the same event id (see `makeEvent`),
    // so one materialized message row covers both.
    seedMessageDb("01EVENT123");

    const router = new Router();
    const seqs: number[] = [];

    router.subscribe((events) => {
      for (const e of events) {
        if (e.kind === "messageDiff") {
          seqs.push(e.signal.seq);
        }
      }
    });

    router.onEventsApplied(
      STREAM_DID,
      [
        makeEvent("space.roomy.message.createMessage.v0", {
          roomId: "01ROOM1AAAAAAAAAAAAAA000" as Ulid,
        }),
      ],
      { isBackfill: false },
    );

    router.onEventsApplied(
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

  it("unsubscribe stops delivery", () => {
    const router = new Router();
    let count = 0;

    const unsub = router.subscribe(() => count++);

    router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );
    expect(count).toBe(1);

    unsub();

    router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );
    expect(count).toBe(1); // No increase.
  });

  it("continues delivering to other listeners when one throws", () => {
    const router = new Router();
    let secondReceived = 0;

    router.subscribe(() => {
      throw new Error("boom");
    });
    router.subscribe(() => secondReceived++);

    // Should not throw, and second listener should still be called.
    router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.space.updateSidebar.v1")],
      { isBackfill: false },
    );

    expect(secondReceived).toBe(1);
  });

  it("batches signals from multiple events in one callback", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    router.onEventsApplied(
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

  it("skips dispatch when all events produce no signals", () => {
    const router = new Router();
    const { events, listener } = collect();
    router.subscribe(listener);

    // page edit is out of scope → no signals.
    router.onEventsApplied(
      STREAM_DID,
      [makeEvent("space.roomy.page.editPage.v0")],
      { isBackfill: false },
    );

    expect(events).toHaveLength(0);
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
});
