import { describe, expect, test } from "bun:test";
import type { ClientMessage, Frame, SyncSocket } from "../xrpc/types.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  AppliedEvent,
} from "../invalidation/types.ts";
import type { DecodedStreamEvent, Event, StreamDid, StreamIndex, UserDid, Ulid } from "@roomy-space/sdk";
import { SyncManager, type StreamEventSource } from "./handler.ts";

// ─── Mock infrastructure ─────────────────────────────────────────────────

/** Mock SyncSocket that collects sent frames and allows injecting messages. */
class MockSocket {
  readonly did: string;
  readonly sentFrames: Frame[] = [];
  private messageHandler?: (msg: ClientMessage) => void;
  private closeHandler?: () => void;
  private _isOpen = true;

  constructor(did: string) {
    this.did = did;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  send(frame: Frame): void {
    this.sentFrames.push(frame);
  }

  onMessage(handler: (msg: ClientMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** Simulate a client message. */
  receive(msg: ClientMessage): void {
    this.messageHandler?.(msg);
  }

  /** Simulate connection close. */
  close(): void {
    this._isOpen = false;
    this.closeHandler?.();
  }
}

/** Mock InvalidationRouter that lets tests emit signals. */
class MockRouter implements InvalidationRouter {
  private listeners: ((events: readonly InvalidationEvent[]) => void)[] = [];

  onEventsApplied(
    _streamDid: StreamDid,
    _events: readonly AppliedEvent[],
    _meta: { isBackfill: boolean },
  ): void {
    // Not used in sync tests — we call emitSignals directly.
  }

  subscribe(
    listener: (events: readonly InvalidationEvent[]) => void,
  ): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(signals: readonly InvalidationEvent[]): void {
    for (const listener of this.listeners) {
      listener(signals);
    }
  }

  /** Emit signals to all subscribers (test helper). */
  emitSignals(events: InvalidationEvent[]): void {
    for (const listener of this.listeners) {
      listener(events);
    }
  }
}

/** Minimal stream source mock — no events, just satisfies the constructor. */
class MockStreamManager implements StreamEventSource {
  onEvents(): () => void {
    return () => {};
  }
  getEventsFrom(): Promise<{ events: never[]; cursor: number }> {
    return Promise.resolve({ events: [], cursor: 0 });
  }
}

/** Shared mock instance. */
const mockStreamManager: StreamEventSource = new MockStreamManager();

// ─── Helpers ─────────────────────────────────────────────────────────────

const SPACE_ID = "did:web:space.example" as StreamDid;
const ROOM_ID = "01KR32FDQCCCEB8FEK76SQST9Y" as Ulid;
const USER_A = "did:plc:user-a" as UserDid;
const USER_B = "did:plc:user-b" as UserDid;

function queryInvalidation(
  nsid: string,
  params: Record<string, string>,
  affectedUser?: UserDid,
): InvalidationEvent {
  return {
    kind: "queryInvalidation",
    signal: {
      nsid: nsid as InvalidationEvent["signal"] extends { nsid: infer N }
        ? N
        : never,
      params,
      affectedUser,
    },
  };
}

function messageDiff(roomId: Ulid, seq: number): InvalidationEvent {
  return {
    kind: "messageDiff",
    signal: {
      roomId,
      seq,
      ops: [
        {
          op: "add",
          key: "01KR32FDQCCCEB8FEK76SQST9Z" as Ulid,
          message: {
            id: "01KR32FDQCCCEB8FEK76SQST9Z" as Ulid,
            sort_idx: "01KR32FDQCCCEB8FEK76SQST9Z",
            content: "hello",
            authorDid: USER_A,
            authorName: "User A",
            timestamp: new Date().toISOString(),
            reactions: [],
            media: [],
            linkEmbeds: [],
          },
        },
      ],
    },
  };
}

/** Extract body from a CBOR-encoded frame (we know the structure). */
function decodeFrameBody(frame: Frame): Record<string, unknown> {
  return frame.body;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("SyncManager", () => {
  test("message diff is sent to connections subscribed to the room", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    // Subscribe to room topic. (Room sub also eagerly invalidates room-scoped
    // queries — 3 #invalidate frames — see SyncManager.#sendRoomInvalidation.
    // Clear them so this test asserts only the signal-routing below.)
    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    socket.sentFrames.length = 0;

    // Emit a message diff for that room.
    router.emitSignals([messageDiff(ROOM_ID, 1)]);

    expect(socket.sentFrames.length).toBe(1);
    const body = decodeFrameBody(socket.sentFrames[0]!);
    expect(body).toEqual({
      roomId: ROOM_ID,
      seq: 1,
      ops: expect.any(Array),
    });
    expect(socket.sentFrames[0]!.header.t).toBe("#messageDiff");

    manager.destroy();
  });

  test("message diff is NOT sent to connections not subscribed to the room", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    // Subscribe to a different room. (Room sub eagerly invalidates its room
    // queries — clear those frames so the assertion captures only the signal
    // routing below.)
    socket.receive({ type: "sub", topic: "room", id: "other-room" as Ulid });
    socket.sentFrames.length = 0;

    // Emit a message diff for ROOM_ID.
    router.emitSignals([messageDiff(ROOM_ID, 1)]);

    expect(socket.sentFrames.length).toBe(0);

    manager.destroy();
  });

  test("query invalidation is sent to connections subscribed to the space", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    socket.receive({ type: "sub", topic: "space", id: SPACE_ID });

    router.emitSignals([
      queryInvalidation("space.roomy.space.getMetadata", { spaceId: SPACE_ID }),
    ]);

    expect(socket.sentFrames.length).toBe(1);
    expect(socket.sentFrames[0]!.header.t).toBe("#invalidate");
    expect(decodeFrameBody(socket.sentFrames[0]!)).toEqual({
      nsid: "space.roomy.space.getMetadata",
      params: { spaceId: SPACE_ID },
    });

    manager.destroy();
  });

  test("query invalidation is NOT sent to connections not subscribed to the space", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    // Not subscribed to any topic.
    router.emitSignals([
      queryInvalidation("space.roomy.space.getMetadata", { spaceId: SPACE_ID }),
    ]);

    expect(socket.sentFrames.length).toBe(0);

    manager.destroy();
  });

  test("per-user invalidation only reaches the affected user", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socketA = new MockSocket(USER_A);
    const socketB = new MockSocket(USER_B);
    manager.register(
      socketA as unknown as SyncSocket,
    );
    manager.register(
      socketB as unknown as SyncSocket,
    );

    // Both subscribed to the same space.
    socketA.receive({ type: "sub", topic: "space", id: SPACE_ID });
    socketB.receive({ type: "sub", topic: "space", id: SPACE_ID });

    // Invalidation only for USER_A.
    router.emitSignals([
      queryInvalidation(
        "space.roomy.space.getMetadata",
        { spaceId: SPACE_ID },
        USER_A,
      ),
    ]);

    expect(socketA.sentFrames.length).toBe(1);
    expect(socketB.sentFrames.length).toBe(0);

    manager.destroy();
  });

  test("unsub stops delivery", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    socket.receive({ type: "unsub", topic: "room", id: ROOM_ID });
    // Room sub eagerly invalidated room queries (3 frames); clear so the
    // assertion captures only the post-unsub emit below.
    socket.sentFrames.length = 0;

    router.emitSignals([messageDiff(ROOM_ID, 1)]);

    expect(socket.sentFrames.length).toBe(0);

    manager.destroy();
  });

  test("connection close cleans up subscriptions", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    socket.close();
    // Room sub eagerly invalidated room queries (3 frames); clear so the
    // assertion captures only the post-close emit below.
    socket.sentFrames.length = 0;

    // Emit after close — should not error.
    router.emitSignals([messageDiff(ROOM_ID, 1)]);
    expect(socket.sentFrames.length).toBe(0);
    expect(manager.connectionCount).toBe(0);

    manager.destroy();
  });

  test("getSpaces invalidation reaches all connections regardless of topic subscriptions", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socketA = new MockSocket(USER_A);
    const socketB = new MockSocket(USER_B);
    manager.register(
      socketA as unknown as SyncSocket,
    );
    manager.register(
      socketB as unknown as SyncSocket,
    );

    // A subscribed to a space, B subscribed only to a room.
    socketA.receive({ type: "sub", topic: "space", id: SPACE_ID });
    socketB.receive({ type: "sub", topic: "room", id: ROOM_ID });
    // Room sub eagerly invalidates room-scoped queries (3 #invalidate frames
    // for socketB); clear so the assertions below capture only the getSpaces
    // broadcast.
    socketA.sentFrames.length = 0;
    socketB.sentFrames.length = 0;

    router.emitSignals([queryInvalidation("space.roomy.space.getSpaces", {})]);

    // getSpaces is user-scoped — both connections receive it.
    expect(socketA.sentFrames.length).toBe(1);
    expect(socketB.sentFrames.length).toBe(1);

    manager.destroy();
  });

  test("getSpaces invalidation with affectedUser only reaches that user", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socketA = new MockSocket(USER_A);
    const socketB = new MockSocket(USER_B);
    manager.register(
      socketA as unknown as SyncSocket,
    );
    manager.register(
      socketB as unknown as SyncSocket,
    );

    // Both subscribed to a space.
    socketA.receive({ type: "sub", topic: "space", id: SPACE_ID });
    socketB.receive({ type: "sub", topic: "space", id: SPACE_ID });

    // Only affects USER_A.
    router.emitSignals([
      queryInvalidation("space.roomy.space.getSpaces", {}, USER_A),
    ]);

    expect(socketA.sentFrames.length).toBe(1);
    expect(socketB.sentFrames.length).toBe(0);

    manager.destroy();
  });

  test("cursor triggers full invalidation for subscribed topics", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    socket.receive({ type: "sub", topic: "space", id: SPACE_ID });
    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });

    // Send cursor — should trigger broad invalidation.
    socket.receive({ type: "cursor", seq: 0 });

    // Should have invalidate frames for space + room queries.
    const nsids = socket.sentFrames.map(
      (f) => decodeFrameBody(f).nsid as string,
    );
    expect(nsids).toContain("space.roomy.space.getSpaces");
    expect(nsids).toContain("space.roomy.space.getMetadata");
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.room.getMessages");

    manager.destroy();
  });

  test("room query invalidation routes via room topic", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    // Room sub eagerly invalidated room queries (incl. getMessages — 3 frames);
    // clear so the assertion captures only the routed signal below.
    socket.sentFrames.length = 0;

    router.emitSignals([
      queryInvalidation("space.roomy.room.getMessages", { roomId: ROOM_ID }),
    ]);

    expect(socket.sentFrames.length).toBe(1);
    expect(decodeFrameBody(socket.sentFrames[0]!).nsid).toBe(
      "space.roomy.room.getMessages",
    );

    manager.destroy();
  });

  test("subscribing to a room eagerly invalidates that room's queries", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    // Subscribing to a room immediately emits #invalidate for the room-scoped
    // queries so a client re-fetches fresh data instead of serving stale
    // TanStack cache (see SyncManager.#sendRoomInvalidation).
    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });

    const nsids = socket.sentFrames.map(
      (f) => decodeFrameBody(f).nsid as string,
    );
    expect(nsids).toContain("space.roomy.room.getMessages");
    expect(nsids).toContain("space.roomy.room.getMetadata");
    expect(nsids).toContain("space.roomy.room.getThreads");
    expect(socket.sentFrames.length).toBe(3);
    for (const f of socket.sentFrames) {
      expect(f.header.t).toBe("#invalidate");
      expect(decodeFrameBody(f).params).toEqual({ roomId: ROOM_ID });
    }

    manager.destroy();
  });

  test("destroy unsubscribes from router", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );
    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    // Room sub eagerly invalidated room queries (3 frames); clear so the
    // assertion captures only the post-destroy emit below.
    socket.sentFrames.length = 0;

    manager.destroy();

    // Emit after destroy — socket should NOT receive anything.
    router.emitSignals([messageDiff(ROOM_ID, 1)]);
    expect(socket.sentFrames.length).toBe(0);
  });

  test("multiple events in one batch are all delivered", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter, mockStreamManager);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    // Room sub eagerly invalidated room queries (incl. getMetadata — 3 frames);
    // clear so the assertion captures only the two routed signals below.
    socket.sentFrames.length = 0;

    router.emitSignals([
      messageDiff(ROOM_ID, 1),
      queryInvalidation("space.roomy.room.getMetadata", { roomId: ROOM_ID }),
    ]);

    expect(socket.sentFrames.length).toBe(2);
    expect(socket.sentFrames[0]!.header.t).toBe("#messageDiff");
    expect(socket.sentFrames[1]!.header.t).toBe("#invalidate");

    manager.destroy();
  });
});

// ─── Stream topic tests ─────────────────────────────────────────────────

/** A StreamEventSource mock that can emit live events and serve backfill. */
class FakeStreamSource implements StreamEventSource {
  private listeners: Array<(streamDid: StreamDid, events: readonly DecodedStreamEvent[]) => void> = [];
  /** In-memory event log keyed by stream DID. */
  private events = new Map<string, DecodedStreamEvent[]>();
  /** Optional deferred the next getEventsFrom call must await, so tests can
   *  emit live events mid-backfill while backfilling is still true. */
  private gated: {
    promise: Promise<{ events: DecodedStreamEvent[]; cursor: number }>;
    resolve: (value: { events: DecodedStreamEvent[]; cursor: number }) => void;
  } | null = null;

  onEvents(listener: (streamDid: StreamDid, events: readonly DecodedStreamEvent[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getEventsFrom(streamDid: StreamDid, cursor: number, limit: number): Promise<{ events: DecodedStreamEvent[]; cursor: number }> {
    if (this.gated) {
      const gated = this.gated;
      this.gated = null;
      return gated.promise;
    }
    const all = this.events.get(streamDid) ?? [];
    const slice = all.filter((e) => e.idx > cursor).slice(0, limit);
    const newCursor = slice.length > 0 ? slice[slice.length - 1]!.idx : cursor;
    return Promise.resolve({ events: slice, cursor: newCursor });
  }

  /** Make the next getEventsFrom call await a deferred promise. Returns the
   *  resolve function so the test can release it after emitting live events,
   *  exercising the mid-backfill race. */
  gateNextGetEvents(): (value: { events: DecodedStreamEvent[]; cursor: number }) => void {
    const { promise, resolve } = Promise.withResolvers<{ events: DecodedStreamEvent[]; cursor: number }>();
    this.gated = { promise, resolve };
    return resolve;
  }

  /** Seed events into a stream (assigns sequential idx values). */
  seed(streamDid: StreamDid, count: number): DecodedStreamEvent[] {
    const existing = this.events.get(streamDid) ?? [];
    const startIdx = existing.length > 0 ? existing[existing.length - 1]!.idx + 1 : 0;
    const seeded: DecodedStreamEvent[] = [];
    for (let i = 0; i < count; i++) {
      seeded.push({
        idx: (startIdx + i) as StreamIndex,
        event: { $type: "space.roomy.space.updateInfo", id: `seed-${startIdx + i}` } as unknown as Event,
        user: USER_A,
      });
    }
    this.events.set(streamDid, [...existing, ...seeded]);
    return seeded;
  }

  /** Emit a live event batch to all registered listeners. */
  emitLive(streamDid: StreamDid, events: DecodedStreamEvent[]): void {
    const existing = this.events.get(streamDid) ?? [];
    this.events.set(streamDid, [...existing, ...events]);
    for (const listener of this.listeners) {
      listener(streamDid, events);
    }
  }
}

function streamEvent(idx: number, user: UserDid = USER_A): DecodedStreamEvent {
  return {
    idx: idx as StreamIndex,
    event: { $type: "space.roomy.message.createMessage.v0", id: `evt-${idx}` } as Event,
    user,
  };
}

/** Drain the microtask queue enough for async backfill to complete. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("SyncManager — stream topic", () => {
  test("subscribing backfills events from the cursor", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    // Seed 3 events before subscribing.
    source.seed(SPACE_ID, 3);

    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);

    // Subscribe from cursor -1 (full backfill — cursor is exclusive).
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: -1 });

    // Backfill is async — let it drain.
    await flush();

    const frames = socket.sentFrames.filter((f) => f.header.t === "#streamEvents");
    expect(frames.length).toBe(1);
    const body = frames[0]!.body;
    expect(body["streamDid"]).toBe(SPACE_ID);
    expect(body["cursor"]).toBe(2);
    expect(body["hasMore"]).toBe(false);
    const events = body["events"] as Array<{ idx: number }>;
    expect(events.length).toBe(3);
    expect(events[0]!.idx).toBe(0);
    expect(events[2]!.idx).toBe(2);

    manager.destroy();
  });

  test("subscribing from a non-zero cursor skips already-seen events", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    source.seed(SPACE_ID, 5);

    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);

    // Resume from cursor 2 — should get events 3 and 4 only.
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: 2 });

    await flush();

    const frames = socket.sentFrames.filter((f) => f.header.t === "#streamEvents");
    expect(frames.length).toBe(1);
    const events = frames[0]!.body["events"] as Array<{ idx: number }>;
    expect(events.length).toBe(2);
    expect(events[0]!.idx).toBe(3);
    expect(events[1]!.idx).toBe(4);
    expect(frames[0]!.body["cursor"]).toBe(4);

    manager.destroy();
  });

  test("live events are delivered after backfill completes", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);

    // Subscribe to an empty stream — backfill finds nothing.
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: 0 });
    await flush();

    // Now emit a live event.
    source.emitLive(SPACE_ID, [streamEvent(0)]);
    await flush();

    const frames = socket.sentFrames.filter((f) => f.header.t === "#streamEvents");
    expect(frames.length).toBe(1);
    expect(frames[0]!.body["cursor"]).toBe(0);
    expect(frames[0]!.body["hasMore"]).toBe(false);
    const events = frames[0]!.body["events"] as Array<{ idx: number }>;
    expect(events.length).toBe(1);
    expect(events[0]!.idx).toBe(0);

    manager.destroy();
  });

  test("an empty live-event batch does not throw or deliver", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: 0 });
    await flush();

    socket.sentFrames.length = 0;
    // Emitting an empty batch must not throw (previously events[-1]!.idx did).
    source.emitLive(SPACE_ID, []);
    await flush();

    expect(socket.sentFrames.filter((f) => f.header.t === "#streamEvents").length).toBe(0);

    manager.destroy();
  });

  test("live events arriving during backfill are drained via pendingLive", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    // Seed 2 events — backfill fetches them in a short (< 100) batch.
    source.seed(SPACE_ID, 2);
    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);

    // Gate the first backfill read so the loop is suspended mid-await with
    // backfilling=true, letting us emit a live event into the race window.
    const releaseFirst = source.gateNextGetEvents();
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: -1 });

    // Release the first read (idx 0,1), then emit a live event (idx 2) while
    // the backfill loop is still suspended — #onStreamEvents must set
    // pendingLive instead of delivering (or dropping) the event.
    releaseFirst({ events: [streamEvent(0), streamEvent(1)], cursor: 1 });
    source.emitLive(SPACE_ID, [streamEvent(2)]);
    await flush();

    const frames = socket.sentFrames.filter((f) => f.header.t === "#streamEvents");
    // First frame: backfill (idx 0,1). Second frame: pendingLive drain (idx 2).
    expect(frames.length).toBe(2);
    const backfillEvents = frames[0]!.body["events"] as Array<{ idx: number }>;
    expect(backfillEvents.map((e) => e.idx)).toEqual([0, 1]);
    const liveEvents = frames[1]!.body["events"] as Array<{ idx: number }>;
    expect(liveEvents.length).toBe(1);
    expect(liveEvents[0]!.idx).toBe(2);
    expect(frames[1]!.body["cursor"]).toBe(2);
    expect(frames[1]!.body["hasMore"]).toBe(false);

    manager.destroy();
  });

  test("re-subscribing while backfill is in flight does not spawn a second loop", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    source.seed(SPACE_ID, 2);
    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);

    // Gate the first backfill read so the loop is in flight (backfilling=true).
    const releaseFirst = source.gateNextGetEvents();
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: -1 });

    // Re-subscribe while the first loop is suspended (backfilling=true).
    // Before the M5 fix this reset backfilling=false and kicked off a second
    // concurrent #backfillStream, producing a duplicate backfill frame.
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: -1 });

    // Release the first read; the running loop completes (short batch).
    releaseFirst({ events: [streamEvent(0), streamEvent(1)], cursor: 1 });
    await flush();

    const frames = socket.sentFrames.filter((f) => f.header.t === "#streamEvents");
    // Exactly one backfill frame — no duplicate from a second loop.
    expect(frames.length).toBe(1);
    const events = frames[0]!.body["events"] as Array<{ idx: number }>;
    expect(events.map((e) => e.idx)).toEqual([0, 1]);

    manager.destroy();
  });

  test("unsub stops stream delivery", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: 0 });
    await flush();

    socket.sentFrames.length = 0;
    socket.receive({ type: "unsub", topic: "stream", id: SPACE_ID });

    source.emitLive(SPACE_ID, [streamEvent(0)]);
    await flush();

    const frames = socket.sentFrames.filter((f) => f.header.t === "#streamEvents");
    expect(frames.length).toBe(0);

    manager.destroy();
  });

  test("connection close cleans up stream subscription", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: 0 });
    await flush();

    socket.close();

    // Emitting live events after close should not throw and should not deliver.
    source.emitLive(SPACE_ID, [streamEvent(0)]);
    await flush();
    expect(socket.sentFrames.filter((f) => f.header.t === "#streamEvents").length).toBe(0);

    manager.destroy();
  });

  test("stale backfill loop exits after unsub + re-sub (identity check)", async () => {
    const router = new MockRouter();
    const source = new FakeStreamSource();
    const manager = new SyncManager(router as unknown as InvalidationRouter, source);

    // Seed 5 events (idx 0-4).
    source.seed(SPACE_ID, 5);
    const socket = new MockSocket(USER_A);
    manager.register(socket as unknown as SyncSocket);

    // Subscribe with cursor -1 — backfill #1 (stale sub A) suspends at the
    // gated getEventsFrom with backfilling=true.
    const releaseStale = source.gateNextGetEvents();
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: -1 });

    // Emit a live event while backfill #1 is suspended — #onStreamEvents sees
    // sub A with backfilling=true and arms sub A.pendingLive. This event is
    // also persisted in the source so the fresh backfill will read it later.
    source.emitLive(SPACE_ID, [streamEvent(5)]);

    // Bridge reconnect pattern: unsub (deletes sub A) then re-sub with a
    // different cursor (creates a NEW sub B object and kicks off backfill #2).
    socket.receive({ type: "unsub", topic: "stream", id: SPACE_ID });
    socket.receive({ type: "sub", topic: "stream", id: SPACE_ID, cursor: 2 });

    // Release the stale backfill's gated read with an empty batch so it
    // breaks out of the for-loop. With the identity guard, the post-loop
    // check sees state.streams.get(streamDid) === sub B ≠ sub A and returns
    // BEFORE draining pendingLive — no stale-cursor frames are sent.
    // (Without the fix, the key-presence guard passes, sub A.pendingLive
    // is true, and the stale loop drains and delivers stale-cursor frames.)
    releaseStale({ events: [], cursor: -1 });
    await flush();

    const frames = socket.sentFrames.filter((f) => f.header.t === "#streamEvents");
    // Exactly one frame — the fresh-cursor backfill (sub B, cursor 2 →
    // events idx 3,4,5). No stale-cursor frames from the orphaned sub A.
    expect(frames.length).toBe(1);
    const events = frames[0]!.body["events"] as Array<{ idx: number }>;
    expect(events.map((e) => e.idx)).toEqual([3, 4, 5]);
    expect(frames[0]!.body["cursor"]).toBe(5);

    manager.destroy();
  });
});
