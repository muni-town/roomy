import { describe, expect, test } from "bun:test";
import type { ClientMessage, Frame } from "../xrpc/types.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  AppliedEvent,
} from "../invalidation/types.ts";
import type { StreamDid, UserDid, Ulid } from "@roomy-space/sdk";
import { SyncManager } from "./handler.ts";

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
            forwardedFrom: null,
            reactions: [],
            media: [],
            tags: [],
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
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
    );

    // Subscribe to room topic.
    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });

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
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
    );

    // Subscribe to a different room.
    socket.receive({ type: "sub", topic: "room", id: "other-room" as Ulid });

    // Emit a message diff for ROOM_ID.
    router.emitSignals([messageDiff(ROOM_ID, 1)]);

    expect(socket.sentFrames.length).toBe(0);

    manager.destroy();
  });

  test("query invalidation is sent to connections subscribed to the space", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
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
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
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
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socketA = new MockSocket(USER_A);
    const socketB = new MockSocket(USER_B);
    manager.register(
      socketA as unknown as import("../xrpc/types.ts").SyncSocket,
    );
    manager.register(
      socketB as unknown as import("../xrpc/types.ts").SyncSocket,
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
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    socket.receive({ type: "unsub", topic: "room", id: ROOM_ID });

    router.emitSignals([messageDiff(ROOM_ID, 1)]);

    expect(socket.sentFrames.length).toBe(0);

    manager.destroy();
  });

  test("connection close cleans up subscriptions", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });
    socket.close();

    // Emit after close — should not error.
    router.emitSignals([messageDiff(ROOM_ID, 1)]);
    expect(socket.sentFrames.length).toBe(0);
    expect(manager.connectionCount).toBe(0);

    manager.destroy();
  });

  test("getSpaces invalidation reaches all connections with a space topic", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socketA = new MockSocket(USER_A);
    const socketB = new MockSocket(USER_B);
    manager.register(
      socketA as unknown as import("../xrpc/types.ts").SyncSocket,
    );
    manager.register(
      socketB as unknown as import("../xrpc/types.ts").SyncSocket,
    );

    // A subscribed to a space, B subscribed only to a room.
    socketA.receive({ type: "sub", topic: "space", id: SPACE_ID });
    socketB.receive({ type: "sub", topic: "room", id: ROOM_ID });

    router.emitSignals([queryInvalidation("space.roomy.space.getSpaces", {})]);

    expect(socketA.sentFrames.length).toBe(1);
    expect(socketB.sentFrames.length).toBe(0); // no space topic

    manager.destroy();
  });

  test("getSpaces invalidation with affectedUser only reaches that user", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socketA = new MockSocket(USER_A);
    const socketB = new MockSocket(USER_B);
    manager.register(
      socketA as unknown as import("../xrpc/types.ts").SyncSocket,
    );
    manager.register(
      socketB as unknown as import("../xrpc/types.ts").SyncSocket,
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
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
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
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });

    router.emitSignals([
      queryInvalidation("space.roomy.room.getMessages", { roomId: ROOM_ID }),
    ]);

    expect(socket.sentFrames.length).toBe(1);
    expect(decodeFrameBody(socket.sentFrames[0]!).nsid).toBe(
      "space.roomy.room.getMessages",
    );

    manager.destroy();
  });

  test("destroy unsubscribes from router", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
    );
    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });

    manager.destroy();

    // Emit after destroy — socket should NOT receive anything.
    router.emitSignals([messageDiff(ROOM_ID, 1)]);
    expect(socket.sentFrames.length).toBe(0);
  });

  test("multiple events in one batch are all delivered", () => {
    const router = new MockRouter();
    const manager = new SyncManager(router as unknown as InvalidationRouter);

    const socket = new MockSocket(USER_A);
    manager.register(
      socket as unknown as import("../xrpc/types.ts").SyncSocket,
    );

    socket.receive({ type: "sub", topic: "room", id: ROOM_ID });

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
