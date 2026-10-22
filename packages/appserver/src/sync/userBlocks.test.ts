/**
 * The live path and a block: what a connection receives, and what it is told.
 *
 * A block hides in both directions, and the frames are built once per room
 * topic, so the only place a viewer's block set can be applied is where the
 * frame meets the connection. This file drives that fan-out with two
 * connections in one room: one that hides the author, one that does not, and
 * then the same pair reversed.
 *
 * A hidden author's row is the same tombstone `room.getMessages` returns — the
 * shared `blockedTombstone` — so a client that applies the diff and a client
 * that fetches the page agree about what is hidden.
 *
 * There is no admin exception anywhere on this page: the live frame, the unread
 * count and the push all run without the caller present, so an admin who placed
 * the block receives the tombstone like anyone else and reads the one message
 * they may reveal through `getMessage`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientMessage, Frame, SyncSocket } from "../xrpc/types.ts";
import type {
  InvalidationEvent,
  InvalidationRouter,
  AppliedEvent,
  MessageDiffOp,
  RoomActivityDiffActivity,
} from "../invalidation/types.ts";
import type { StreamDid, UserDid, Ulid } from "@roomy-space/sdk";

import { closeDb, openDb } from "../db/db.ts";
import type { DbLike } from "../db/types.ts";
import { _setTestFetchBlockRecords, type BlockRecord } from "../materialization/blocks.ts";
import {
  _blockRefreshesInFlight,
  _resetBlockCaches,
  refreshBlockSet,
} from "../queries/userBlocks.ts";
import { SyncManager, type StreamEventSource, type SyncDbAccess } from "./handler.ts";

const SPACE = "did:web:space.example" as StreamDid;
const ROOM = "01KR32FDQCCCEB8FEK76SQST9Y" as Ulid;
const MESSAGE = "01KR32FDQCCCEB8FEK76SQST9Z";
const ALICE = "did:plc:alice" as UserDid;
const BOB = "did:plc:bob" as UserDid;

/** A block record in the shape the PDS fetch produces. */
const block = (subject: string): BlockRecord => ({
  subject,
  source: "roomy",
  createdAt: null,
});

// ─── Socket / router doubles ──────────────────────────────────────────────
//
// Deliberately local to this file: `handler.test.ts`'s doubles carry the whole
// access surface (federation, bans, public join) that these tests never reach.

/** A connection that records what it was sent. */
class MockSocket {
  readonly sent: Frame[] = [];
  private messageHandler?: (msg: ClientMessage) => void;
  private _isOpen = true;

  constructor(readonly did: string) {}

  get isOpen(): boolean {
    return this._isOpen;
  }

  send(frame: Frame): void {
    this.sent.push(frame);
  }

  onMessage(handler: (msg: ClientMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(): void {}

  receive(msg: ClientMessage): void {
    this.messageHandler?.(msg);
  }

  /** The frames of one type, in arrival order. */
  ofType(t: string): Frame[] {
    return this.sent.filter((f) => f.header.t === t);
  }
}

/** A router the test drives directly. */
class MockRouter implements InvalidationRouter {
  #listeners: Array<(events: readonly InvalidationEvent[]) => void> = [];

  onEventsApplied(
    _streamDid: StreamDid,
    _events: readonly AppliedEvent[],
    _meta: { isBackfill: boolean },
  ): void {}

  subscribe(listener: (events: readonly InvalidationEvent[]) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  emit(signals: readonly InvalidationEvent[]): void {
    for (const listener of this.#listeners) listener(signals);
  }
}

class NoStreams implements StreamEventSource {
  onEvents(): () => void {
    return () => {};
  }
  getEventsFrom(): Promise<{ events: never[]; cursor: number }> {
    return Promise.resolve({ events: [], cursor: 0 });
  }
}

/**
 * The access surface the manager reads, answered from one fact: who is a member
 * of the space. These tests exercise the block filter, not authorization, so
 * every room resolves as an ordinary readable channel for every caller.
 */
class MockDbAccess implements SyncDbAccess {
  constructor(readonly members: Set<string>) {}

  async openSpaceDbForEntity(entityId: string): Promise<DbLike | null> {
    return entityId === ROOM ? this.#space() : null;
  }

  openSpaceDb(): DbLike {
    return this.#space();
  }

  openGlobalDb(): DbLike {
    return this.#space();
  }

  #space(): DbLike {
    const members = this.members;
    const db: DbLike = {
      query(sql: string) {
        return {
          async get<T>(...params: unknown[]): Promise<T | null> {
            // The access unit binds as a single array: `.get([spaceId, did])`.
            const p = (params[0] ?? []) as unknown[];
            if (sql.includes("from room_access")) return null;
            if (sql.includes("label = 'member'")) {
              return members.has(p[1] as string) ? ({ n: 1 } as T) : null;
            }
            if (sql.includes("label = 'admin'")) return null;
            if (sql.includes("from comp_bans")) return null;
            if (sql.includes("from member_roles")) {
              return { has_read: 0, has_write: 0 } as T;
            }
            if (sql.includes("from comp_space")) return { v: 1 } as T;
            if (sql.includes("from entities e")) {
              return { space_id: SPACE, default_access: "readwrite" } as T;
            }
            if (sql.includes("label = 'link'")) return null;
            if (sql.includes("from comp_room")) return { default_access: "readwrite" } as T;
            throw new Error(`unexpected query: ${sql}`);
          },
          async all<T>(): Promise<T[]> {
            return [] as T[];
          },
        };
      },
      prepare: async () => {
        throw new Error("not used");
      },
      // A no-op: the access projection misses on read and warming it is
      // best-effort, so a throwing stub would log a warning per frame.
      exec: async () => {},
      run: async () => ({ changes: 0 }),
      transaction: async () => {
        throw new Error("not used");
      },
      close: async () => {},
    };
    return db;
  }
}

// ─── Frames ───────────────────────────────────────────────────────────────

/** A complete `MessageDto`, as `selectMessages` returns one. */
function message(authorDid: UserDid) {
  return {
    id: MESSAGE,
    sort_idx: MESSAGE,
    content: "a body the block must withhold",
    authorDid,
    authorName: "Author",
    timestamp: new Date(1_700_000_000_000).toISOString(),
    attachments: [],
    reactions: [],
    media: [],
    linkEmbeds: [],
  };
}

function messageDiff(authorDid: UserDid): InvalidationEvent {
  const ops: MessageDiffOp[] = [
    { op: "add", key: MESSAGE as Ulid, message: message(authorDid) },
  ];
  return { kind: "messageDiff", signal: { roomId: ROOM, ops } };
}

function mentionDiff(mentioned: UserDid, authorDid: UserDid): InvalidationEvent {
  const ops: MessageDiffOp[] = [
    { op: "add", key: MESSAGE as Ulid, message: message(authorDid) },
  ];
  return { kind: "mentionDiff", signal: { did: mentioned, spaceId: SPACE, roomId: ROOM, ops } };
}

function roomActivityDiff(authorDid: UserDid): InvalidationEvent {
  const author = { did: authorDid, name: "Author", avatar: null };
  const activity: RoomActivityDiffActivity = {
    latestTimestamp: new Date(1_700_000_000_000).toISOString(),
    latestMembers: [author],
    latestMessage: {
      id: MESSAGE,
      content: "a preview the block must withhold",
      author,
      timestamp: new Date(1_700_000_000_000).toISOString(),
    },
  };
  return {
    kind: "roomActivityDiff",
    signal: { spaceId: SPACE, roomId: ROOM, kind: "channel", activity },
  };
}

function roomMetadataDiff(authorDid: UserDid, users: UserDid[]): InvalidationEvent {
  return {
    kind: "roomMetadataDiff",
    signal: { spaceId: SPACE, roomId: ROOM, authorDid, delta: 1, users },
  };
}

// ─── Fixture ──────────────────────────────────────────────────────────────

let manager: SyncManager;
let router: MockRouter;
let aliceSocket: MockSocket;
let bobSocket: MockSocket;

/**
 * Yield one event-loop turn. Delivery is asynchronous end to end — the access
 * re-check and the block-set lookup both round-trip through a DB pool — so a
 * microtask drain observes nothing; `setImmediate` yields exactly the turn
 * without spending wall-clock time.
 */
function yieldTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Yield until `socket` holds `count` frames of type `t`.
 *
 * Waits on the frame that should arrive rather than on a duration; the deadline
 * is only a safety bound so a genuine absence fails as a missing frame instead
 * of hanging the suite. It has to be wall-clock because the worker round-trip
 * the delivery waits on is not a number of event-loop turns.
 */
async function settle(socket: MockSocket, t: string, count = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (socket.ofType(t).length < count && Date.now() < deadline) {
    await yieldTurn();
  }
}

/** One connection waiting for frames: `[socket, frame type, how many]`. */
type Wait = [MockSocket, string, number?];

/**
 * Publish signals, then wait for the frames each named socket should receive.
 * Waiting on the delivery itself is what keeps these tests free of guessed
 * durations: the assertion runs against a frame that has demonstrably arrived.
 */
async function emit(events: InvalidationEvent[], ...waits: Wait[]): Promise<void> {
  router.emit(events);
  for (const [socket, t, count] of waits) await settle(socket, t, count ?? 1);
}

/** Connect a socket and join the room topic, then clear the sub's own frames. */
async function join(socket: MockSocket): Promise<void> {
  manager.register(socket as unknown as SyncSocket);
  socket.receive({ type: "sub", topic: "room", id: ROOM });
  // A room subscription answers with one `#invalidate` per room-scoped query
  // once the async access check passes, which is the proof it registered.
  await settle(socket, "#invalidate", 5);
  socket.sent.length = 0;
}

/**
 * Write `records` into `did`'s stored block set, exactly as the PDS refresh
 * path does, so the rows are in place before the next frame is delivered.
 */
async function seedBlocks(did: UserDid, records: BlockRecord[]): Promise<void> {
  _setTestFetchBlockRecords(async () => records);
  await refreshBlockSet(did);
  await Promise.all(_blockRefreshesInFlight());
  _setTestFetchBlockRecords(async () => []);
}

/** The message a `#messageDiff` carried, as the frame body holds it. */
function diffMessage(socket: MockSocket, index = 0): Record<string, unknown> {
  const frame = socket.ofType("#messageDiff")[index]!;
  const ops = frame.body["ops"] as Array<{ message: Record<string, unknown> }>;
  return ops[0]!.message;
}

beforeEach(() => {
  closeDb();
  openDb({ path: ":memory:" });
  _resetBlockCaches();
  // Hermetic: no test may reach a real PDS. The only fetch these tests trigger
  // is the one `refreshBlockSet` runs under `seedBlocks`; every other call
  // resolves to the empty stub.
  _setTestFetchBlockRecords(async () => []);

  router = new MockRouter();
  manager = new SyncManager(router, new NoStreams(), new MockDbAccess(new Set([ALICE, BOB])), {
    // Re-resolve the block set on every delivery, so a test that seeds a block
    // mid-run sees the next frame react to it.
    accessCacheTtlMs: 0,
  });
  aliceSocket = new MockSocket(ALICE);
  bobSocket = new MockSocket(BOB);
});

afterEach(async () => {
  await Promise.all(_blockRefreshesInFlight());
  _setTestFetchBlockRecords(null);
  _resetBlockCaches();
  manager.destroy();
  closeDb();
});

// ─── The live path ────────────────────────────────────────────────────────

describe("SyncManager — a block on the live path", () => {
  test("one connection receives the message, the connection hiding its author receives the tombstone", async () => {
    await seedBlocks(BOB, [block(ALICE)]);
    await join(aliceSocket);
    await join(bobSocket);

    await emit(
      [messageDiff(ALICE)],
      [aliceSocket, "#messageDiff"],
      [bobSocket, "#messageDiff"],
    );

    expect(diffMessage(aliceSocket)["content"]).toBe("a body the block must withhold");
    expect(diffMessage(aliceSocket)["authorName"]).toBe("Author");
    expect(diffMessage(aliceSocket)["blocked"]).toBeUndefined();

    const tombstone = diffMessage(bobSocket);
    expect(tombstone["blocked"]).toBe(true);
    expect(tombstone["content"]).toBe("");
    expect(tombstone["authorName"]).toBe("");
    // Identity and ordering survive, so the row keeps its place and the client
    // has somewhere to draw the indicator.
    expect(tombstone["authorDid"]).toBe(ALICE);
    expect(tombstone["id"]).toBe(MESSAGE);
    expect(tombstone["timestamp"]).toBeTruthy();
  });

  test("the reverse pair is redacted in both directions", async () => {
    // Alice blocked Bob; Bob blocked nobody. Mutual hiding means neither reads
    // the other, so each receives the tombstone for the other's message.
    await seedBlocks(ALICE, [block(BOB)]);
    await join(aliceSocket);
    await join(bobSocket);

    await emit(
      [messageDiff(ALICE)],
      [aliceSocket, "#messageDiff"],
      [bobSocket, "#messageDiff"],
    );
    await emit(
      [messageDiff(BOB)],
      [aliceSocket, "#messageDiff", 2],
      [bobSocket, "#messageDiff", 2],
    );

    // Alice: her own message in full, Bob's as a tombstone.
    expect(diffMessage(aliceSocket, 0)["content"]).toBe("a body the block must withhold");
    expect(diffMessage(aliceSocket, 1)["blocked"]).toBe(true);

    // Bob: Alice's as a tombstone, his own in full.
    expect(diffMessage(bobSocket, 0)["blocked"]).toBe(true);
    expect(diffMessage(bobSocket, 0)["content"]).toBe("");
    expect(diffMessage(bobSocket, 1)["content"]).toBe("a body the block must withhold");
  });

  test("the activity preview and its author are withheld, the board row still moves", async () => {
    await seedBlocks(BOB, [block(ALICE)]);
    await join(aliceSocket);
    await join(bobSocket);

    await emit(
      [roomActivityDiff(ALICE)],
      [aliceSocket, "#roomActivityDiff"],
      [bobSocket, "#roomActivityDiff"],
    );

    const aliceActivity = aliceSocket.ofType("#roomActivityDiff")[0]!.body["activity"] as {
      latestMessage?: { content: string };
      latestMembers: Array<{ did: string }>;
    };
    expect(aliceActivity.latestMessage?.content).toBe("a preview the block must withhold");
    expect(aliceActivity.latestMembers.map((m) => m.did)).toEqual([ALICE]);

    const bobActivity = bobSocket.ofType("#roomActivityDiff")[0]!.body["activity"] as {
      latestTimestamp?: string;
      latestMessage?: unknown;
      latestMembers: Array<{ did: string }>;
    };
    expect(bobActivity.latestMessage).toBeUndefined();
    expect(bobActivity.latestMembers).toEqual([]);
    // The timestamp is viewer-independent and stays, so the board still
    // reorders instead of being refetched.
    expect(bobActivity.latestTimestamp).toBeTruthy();
  });

  test("a mention of a hider's message is redacted to the same tombstone", async () => {
    await seedBlocks(BOB, [block(ALICE)]);
    await join(aliceSocket);
    await join(bobSocket);
    // `#mention` routes on the mentioned user's own topic, so each subscribes
    // to theirs; the registration is synchronous, unlike the room one.
    bobSocket.receive({ type: "sub", topic: "mentions", id: BOB });
    bobSocket.sent.length = 0;

    await emit([mentionDiff(BOB, ALICE)], [bobSocket, "#mention"]);

    const ops = bobSocket.ofType("#mention")[0]!.body["ops"] as Array<{
      message: Record<string, unknown>;
    }>;
    expect(ops[0]!.message["blocked"]).toBe(true);
    expect(ops[0]!.message["content"]).toBe("");
    expect(ops[0]!.message["authorDid"]).toBe(ALICE);
  });

  test("a hidden author's message does not bump a hider's unread count", async () => {
    await seedBlocks(BOB, [block(ALICE)]);
    await join(aliceSocket);
    await join(bobSocket);
    // Warm both connections' block sets, so the two per-user deliveries below
    // resolve from cache and complete in the same event-loop turn.
    await emit(
      [messageDiff(ALICE)],
      [aliceSocket, "#messageDiff"],
      [bobSocket, "#messageDiff"],
    );
    aliceSocket.sent.length = 0;
    bobSocket.sent.length = 0;

    await emit([roomMetadataDiff(ALICE, [ALICE, BOB])], [aliceSocket, "#roomMetadataDiff"]);
    await yieldTurn();

    // Alice placed no block, so her badge moves; Bob's does not — the count he
    // would be patching already excludes the message, and a frame here would
    // also tell him a hidden author had posted.
    expect(aliceSocket.ofType("#roomMetadataDiff")).toHaveLength(1);
    expect(bobSocket.ofType("#roomMetadataDiff")).toHaveLength(0);
  });

  test("the space's own messages are never redacted", async () => {
    // A system message's author is the space itself, which is not a blockable
    // identity: "X joined the space" must survive a member's block.
    await seedBlocks(BOB, [block(ALICE)]);
    await join(bobSocket);

    await emit([messageDiff(SPACE as unknown as UserDid)], [bobSocket, "#messageDiff"]);

    expect(diffMessage(bobSocket)["content"]).toBe("a body the block must withhold");
    expect(diffMessage(bobSocket)["blocked"]).toBeUndefined();
  });

  test("an admin who placed the block is redacted on the live path like anyone else", async () => {
    // The reveal lives on exactly one route — `message.getMessage` by id. The
    // live frame is built once per room topic and fanned to every subscriber,
    // so there is no caller here to widen it for, admin or not.
    await seedBlocks(BOB, [block(ALICE)]);
    await join(aliceSocket);
    await join(bobSocket);

    await emit(
      [messageDiff(ALICE)],
      [aliceSocket, "#messageDiff"],
      [bobSocket, "#messageDiff"],
    );

    expect(diffMessage(bobSocket)["blocked"]).toBe(true);
    expect(diffMessage(bobSocket)["content"]).toBe("");
  });
});
