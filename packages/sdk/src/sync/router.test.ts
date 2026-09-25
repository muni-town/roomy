import { describe, expect, it, vi } from "vitest";
import type { SyncConnection, SyncFrame, Unsubscribe } from "./connection";
import { SyncRouter } from "./router";
import type { CacheAdapter, CachePatcher, QueryKey } from "../cache/adapter";
import type { Message } from "./diff";

function mockConnection(): {
  conn: Pick<SyncConnection, "onFrame">;
  emit: (frame: SyncFrame) => void;
} {
  const handlers = new Set<(f: SyncFrame) => void>();
  return {
    conn: {
      onFrame: (h: (f: SyncFrame) => void): Unsubscribe => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    },
    emit: (frame) => {
      for (const h of handlers) h(frame);
    },
  };
}

function mockAdapter(cached: Map<string, unknown> = new Map()): {
  adapter: CacheAdapter;
  invalidate: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  patchAll: ReturnType<typeof vi.fn>;
} {
  const invalidate = vi.fn((_k: QueryKey) => {});
  const patch = vi.fn((_key: QueryKey, _patcher: CachePatcher<never>) => {});
  const patchAll = vi.fn((_key: QueryKey, _patcher: CachePatcher<never>) => {});
  const adapter: CacheAdapter = {
    // Keyed by the canonical JSON form of the query key, so a test seeds a
    // "cached entry" for the key a router is about to read.
    get<T>(key: QueryKey): T | undefined {
      return cached.get(JSON.stringify(key)) as T | undefined;
    },
    invalidate,
    patch<T>(_key: QueryKey, patcher: CachePatcher<T>) {
      patch(_key, patcher as unknown as CachePatcher<never>);
    },
    patchAll<T>(_key: QueryKey, patcher: CachePatcher<T>) {
      patchAll(_key, patcher as unknown as CachePatcher<never>);
    },
  };
  return { adapter, invalidate, patch, patchAll };
}

function makeFrame(t: string, body: Record<string, unknown>): SyncFrame {
  return { header: { t }, body, raw: new ArrayBuffer(0) };
}

describe("SyncRouter", () => {
  it("routes #invalidate frames into adapter.invalidate with canonical key", () => {
    const { conn, emit } = mockConnection();
    const { adapter, invalidate } = mockAdapter();
    const router = new SyncRouter(conn as SyncConnection, adapter);
    router.start();

    emit(
      makeFrame("#invalidate", {
        nsid: "space.roomy.space.getMetadata",
        // Out-of-order keys to confirm canonical sort.
        params: { spaceId: "01SPACE", other: "x" },
      }),
    );

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]?.[0]).toEqual([
      "space.roomy.space.getMetadata",
      { other: "x", spaceId: "01SPACE" }, // alphabetised
    ]);
  });

  it("routes #messageDiff frames into adapter.patch with applyMessageDiff", () => {
    const { conn, emit } = mockConnection();
    const { adapter, patch } = mockAdapter();
    const router = new SyncRouter(conn as SyncConnection, adapter);
    router.start();

    const msg = {
      id: "01MSG",
      content: "hi",
      authorDid: "did:plc:alice",
      authorName: "alice",
      timestamp: "2026-01-01T00:00:00.000Z",
      reactions: [],
      media: [],
      linkEmbeds: [],
    };

    emit(
      makeFrame("#messageDiff", {
        roomId: "01ROOM",
        seq: 1,
        ops: [{ op: "add", key: "01MSG", message: msg }],
      }),
    );

    expect(patch).toHaveBeenCalledTimes(1);
    const [key, patcher] = patch.mock.calls[0] as [
      QueryKey,
      CachePatcher<Message[]>,
    ];
    expect(key).toEqual([
      "space.roomy.room.getMessages",
      { roomId: "01ROOM" },
    ]);

    // Patcher must handle undefined prev (a diff can race the initial fetch).
    const built = patcher(undefined);
    expect(built).toHaveLength(1);
    expect(built[0]?.id).toBe("01MSG");

    // And with an existing list, append.
    const existing = patcher([msg]);
    expect(existing).toHaveLength(1);
  });

  it("routes #roomMetadataDiff frames into adapter.patch calls", () => {
    const { conn, emit } = mockConnection();
    const { adapter, patch, patchAll } = mockAdapter();
    const router = new SyncRouter(conn as SyncConnection, adapter);
    router.start();

    emit(
      makeFrame("#roomMetadataDiff", {
        spaceId: "did:web:space.example.com",
        roomId: "01ROOM",
        delta: 1,
        seq: 5,
      }),
    );

    // room.getMetadata + space.getMetadata + the space board's unread row =
    // three exact-key patch calls; getSpaces is prefix-matched via patchAll.
    // The board row (space.getThreads) is patched from THIS frame rather than
    // the broadcast #roomActivityDiff, because unreadCount/unread are
    // caller-scoped and only this per-user frame carries the delta.
    expect(patch).toHaveBeenCalledTimes(3);
    expect(patchAll).toHaveBeenCalledTimes(1);

    const keys = patch.mock.calls.map((c) => c[0] as QueryKey);
    expect(keys[0]).toEqual([
      "space.roomy.room.getMetadata",
      { roomId: "01ROOM" },
    ]);
    expect(keys[1]).toEqual([
      "space.roomy.space.getMetadata",
      { spaceId: "did:web:space.example.com" },
    ]);
    expect(keys[2]).toEqual([
      "space.roomy.space.getThreads",
      { spaceId: "did:web:space.example.com" },
    ]);
    // getSpaces patching is prefix-matched, not exact-key.
    expect(patchAll.mock.calls[0]?.[0]).toEqual([
      "space.roomy.space.getSpaces",
    ]);

    // The room.getMetadata patcher adds delta to the cached unreadCount.
    const roomPatch = patch.mock.calls[0]![1] as CachePatcher<unknown>;
    expect(roomPatch({ unreadCount: 2, unreadThreadCount: 0 })).toEqual(
      expect.objectContaining({ unreadCount: 3 }),
    );
    // No cache entry → no-op (returns undefined).
    expect(roomPatch(undefined)).toBeUndefined();

    // The getSpaces patcher adds delta to the matching space's unreadCount.
    const spacesPatch = patchAll.mock.calls[0]![1] as CachePatcher<unknown>;
    expect(
      spacesPatch({
        spaces: [
          { id: "did:web:space.example.com", unreadCount: 4, unreadRoomCount: 1, isMember: true, isAdmin: false, roleIds: [] },
          { id: "did:web:other.example.com", unreadCount: 0, unreadRoomCount: 0, isMember: true, isAdmin: false, roleIds: [] },
        ],
      }),
    ).toEqual({
      spaces: [
        expect.objectContaining({ id: "did:web:space.example.com", unreadCount: 5 }),
        expect.objectContaining({ id: "did:web:other.example.com", unreadCount: 0 }),
      ],
    });

    // The space.getMetadata patcher adds delta to the sidebar channel.
    const spaceMetaPatch = patch.mock.calls[1]![1] as CachePatcher<unknown>;
    const patched = spaceMetaPatch({
      isMember: true,
      isAdmin: false,
      joinPolicy: { allowPublicJoin: false, allowMemberInvites: true },
      unreadRoomCount: 1,
      unreadThreadCount: 0,
      sidebar: {
        categories: [
          { name: "General", position: 0, channels: [
            { id: "01ROOM", defaultAccess: "readwrite", canRead: true, canWrite: true, unreadCount: 2 },
            { id: "02ROOM", defaultAccess: "readwrite", canRead: true, canWrite: true, unreadCount: 0 },
          ] },
        ],
        orphans: [],
      },
    });
    expect(patched.sidebar.categories[0]!.channels[0]!.unreadCount).toBe(3);
    expect(patched.sidebar.categories[0]!.channels[1]!.unreadCount).toBe(0);
  });

  it("routes thread #roomMetadataDiff frames with per-user deltas and parent channel", () => {
    const { conn, emit } = mockConnection();
    const { adapter, patch, patchAll } = mockAdapter();
    const router = new SyncRouter(conn as SyncConnection, adapter);
    router.start();

    emit(
      makeFrame("#roomMetadataDiff", {
        spaceId: "did:web:space.example.com",
        roomId: "01THREAD",
        parentChannelId: "01CHANNEL",
        delta: 1,
        roomUnreadDelta: 0,
        threadUnreadDelta: 1,
        seq: 6,
      }),
    );

    // room.getMetadata (thread) + room.getMetadata (parent channel) +
    // space.getMetadata + the space board row + the parent channel's thread
    // board row = five exact-key patch calls; getSpaces is prefix-matched via
    // patchAll. Both boards' rows are patched here because their unread fields
    // are caller-scoped (absent from the broadcast #roomActivityDiff).
    expect(patch).toHaveBeenCalledTimes(5);
    expect(patchAll).toHaveBeenCalledTimes(1);
    expect(patchAll.mock.calls[0]?.[0]).toEqual([
      "space.roomy.space.getSpaces",
    ]);

    const keys = patch.mock.calls.map((c) => c[0] as QueryKey);
    expect(keys[0]).toEqual([
      "space.roomy.room.getMetadata",
      { roomId: "01THREAD" },
    ]);
    // Parent channel's metadata is patched for the thread count.
    expect(keys[1]).toEqual([
      "space.roomy.room.getMetadata",
      { roomId: "01CHANNEL" },
    ]);
    expect(keys[2]).toEqual([
      "space.roomy.space.getMetadata",
      { spaceId: "did:web:space.example.com" },
    ]);
    // The space index board's row for the THREAD (not the channel).
    expect(keys[3]).toEqual([
      "space.roomy.space.getThreads",
      { spaceId: "did:web:space.example.com" },
    ]);
    // The parent channel's thread board.
    expect(keys[4]).toEqual([
      "space.roomy.room.getThreads",
      { roomId: "01CHANNEL" },
    ]);

    // The parent-channel patcher bumps unreadThreadCount.
    const channelPatch = patch.mock.calls[1]![1] as CachePatcher<unknown>;
    expect(channelPatch({ unreadCount: 0, unreadThreadCount: 2 })).toEqual(
      expect.objectContaining({ unreadThreadCount: 3 }),
    );

    // The getSpaces patcher bumps the combined rooms-with-unreads count by
    // roomUnreadDelta + threadUnreadDelta (0 + 1 here).
    const spacesPatch = patchAll.mock.calls[0]![1] as CachePatcher<unknown>;
    expect(
      spacesPatch({
        spaces: [
          { id: "did:web:space.example.com", unreadCount: 4, unreadRoomCount: 1, isMember: true, isAdmin: false, roleIds: [] },
        ],
      }),
    ).toEqual({
      spaces: [
        expect.objectContaining({ id: "did:web:space.example.com", unreadCount: 5, unreadRoomCount: 2 }),
      ],
    });

    // The space.getMetadata patcher bumps the top-level thread count and the
    // matching active-thread entry under the parent channel.
    const spaceMetaPatch = patch.mock.calls[2]![1] as CachePatcher<unknown>;
    const patched = spaceMetaPatch({
      isMember: true,
      isAdmin: false,
      joinPolicy: { allowPublicJoin: false, allowMemberInvites: true },
      unreadRoomCount: 1,
      unreadThreadCount: 1,
      sidebar: {
        categories: [
          { name: "General", position: 0, channels: [
            { id: "01CHANNEL", defaultAccess: "readwrite", canRead: true, canWrite: true, unreadCount: 0, activeThreads: [
              { id: "01THREAD", canRead: true, canWrite: true, unreadCount: 1, lastRead: null, activity: { latestTimestamp: null, latestMembers: [] } },
            ] },
          ] },
        ],
        orphans: [],
      },
    }) as {
      unreadThreadCount: number;
      sidebar: {
        categories: Array<{
          channels: Array<{ activeThreads?: Array<{ unreadCount: number }> }>;
        }>;
      };
    };
    expect(patched.unreadThreadCount).toBe(2);
    expect(patched.sidebar.categories[0]!.channels[0]!.activeThreads![0]!.unreadCount).toBe(2);
  });

  it("ignores frames that fail arktype validation and surfaces them via callback", () => {
    const { conn, emit } = mockConnection();
    const { adapter, invalidate, patch } = mockAdapter();
    const onValidationError = vi.fn();
    const router = new SyncRouter(conn as SyncConnection, adapter, {
      onValidationError,
    });
    router.start();

    emit(makeFrame("#invalidate", { wrong: "shape" }));

    expect(invalidate).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(onValidationError).toHaveBeenCalledTimes(1);
    expect(onValidationError.mock.calls[0]?.[0]?.frameType).toBe("#invalidate");
  });

  it("patches the cached boards from a #roomActivityDiff and leaves them alone when uncached", () => {
    const spaceKey = JSON.stringify([
      "space.roomy.space.getThreads",
      { spaceId: "did:web:space.example.com" },
    ]);
    const roomKey = JSON.stringify([
      "space.roomy.room.getThreads",
      { roomId: "01CHANNEL" },
    ]);
    const board = {
      id: "01THREAD",
      kind: "thread",
      activity: {
        latestTimestamp: "2026-09-21T07:00:00.000Z",
        latestMembers: [],
      },
    };
    const cached = new Map<string, unknown>([
      [spaceKey, { pages: [{ rooms: [board] }], pageParams: [undefined] }],
      [roomKey, { pages: [{ threads: [board] }], pageParams: [undefined] }],
    ]);
    const { conn, emit } = mockConnection();
    const { adapter, invalidate, patch } = mockAdapter(cached);
    const router = new SyncRouter(conn as SyncConnection, adapter);
    router.start();

    emit(
      makeFrame("#roomActivityDiff", {
        spaceId: "did:web:space.example.com",
        roomId: "01THREAD",
        kind: "thread",
        parentChannelId: "01CHANNEL",
        activity: {
          latestTimestamp: "2026-09-21T10:00:00.000Z",
          latestMembers: [{ did: "did:plc:newcomer", name: null, avatar: null }],
        },
      }),
    );

    // Both boards were patched from their cached page; nothing was invalidated
    // — that is the whole point of the diff.
    expect(invalidate).not.toHaveBeenCalled();
    const patchedKeys = patch.mock.calls.map((c) => c[0] as QueryKey);
    expect(patchedKeys).toContainEqual([
      "space.roomy.space.getThreads",
      { spaceId: "did:web:space.example.com" },
    ]);
    expect(patchedKeys).toContainEqual([
      "space.roomy.room.getThreads",
      { roomId: "01CHANNEL" },
    ]);
    // The parent channel's recentThreads list is patched too.
    expect(patchedKeys).toContainEqual([
      "space.roomy.room.getMetadata",
      { roomId: "01CHANNEL" },
    ]);

    // The board patch moved the room to the front with the new activity.
    const spacePatcher = patch.mock.calls.find(
      (c) => (c[0] as QueryKey)[0] === "space.roomy.space.getThreads",
    )![1] as CachePatcher<{ pages: Array<{ rooms: typeof board[] }> }>;
    const result = spacePatcher(cached.get(spaceKey) as never)!;
    expect(result.pages[0]!.rooms[0]!.activity.latestTimestamp).toBe(
      "2026-09-21T10:00:00.000Z",
    );
  });

  it("invalidates a cached board it cannot patch, and skips boards that aren't cached", () => {
    // The thread is absent from the cached space board (so a patch would be an
    // approximation) — the router must refetch it instead. No room board is
    // cached at all, so there is nothing to correct there.
    const spaceKey = JSON.stringify([
      "space.roomy.space.getThreads",
      { spaceId: "did:web:space.example.com" },
    ]);
    const cached = new Map<string, unknown>([
      [
        spaceKey,
        {
          pages: [
            {
              rooms: [
                {
                  id: "01OTHER",
                  kind: "thread",
                  activity: { latestTimestamp: "2026-09-21T09:00:00.000Z", latestMembers: [] },
                },
              ],
            },
          ],
          pageParams: [undefined],
        },
      ],
    ]);
    const { conn, emit } = mockConnection();
    const { adapter, invalidate, patch } = mockAdapter(cached);
    const router = new SyncRouter(conn as SyncConnection, adapter);
    router.start();

    emit(
      makeFrame("#roomActivityDiff", {
        spaceId: "did:web:space.example.com",
        roomId: "01THREAD",
        kind: "thread",
        parentChannelId: "01CHANNEL",
        activity: {
          latestTimestamp: "2026-09-21T10:00:00.000Z",
          latestMembers: [{ did: "did:plc:newcomer", name: null, avatar: null }],
        },
      }),
    );

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]?.[0]).toEqual([
      "space.roomy.space.getThreads",
      { spaceId: "did:web:space.example.com" },
    ]);
    // The uncached room board is left alone — no invalidation, no patch.
    expect(
      patch.mock.calls.some(
        (c) => (c[0] as QueryKey)[0] === "space.roomy.room.getThreads",
      ),
    ).toBe(false);
  });

  it("ignores unknown frame types to onUnknownFrame", () => {
    const { conn, emit } = mockConnection();
    const { adapter } = mockAdapter();
    const onUnknownFrame = vi.fn();
    const router = new SyncRouter(conn as SyncConnection, adapter, {
      onUnknownFrame,
    });
    router.start();

    emit(makeFrame("#mystery", { x: 1 }));
    expect(onUnknownFrame).toHaveBeenCalledTimes(1);
  });

  it("stop() detaches from the connection", () => {
    const { conn, emit } = mockConnection();
    const { adapter, invalidate } = mockAdapter();
    const router = new SyncRouter(conn as SyncConnection, adapter);
    router.start();
    router.stop();

    emit(
      makeFrame("#invalidate", {
        nsid: "space.roomy.space.getSpaces",
        params: {},
      }),
    );
    expect(invalidate).not.toHaveBeenCalled();
  });
});
