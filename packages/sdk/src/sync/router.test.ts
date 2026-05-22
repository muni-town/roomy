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

function mockAdapter(): {
  adapter: CacheAdapter;
  invalidate: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
} {
  const invalidate = vi.fn((_k: QueryKey) => {});
  const patch = vi.fn((_key: QueryKey, _patcher: CachePatcher<never>) => {});
  const adapter: CacheAdapter = {
    invalidate,
    patch<T>(_key: QueryKey, patcher: CachePatcher<T>) {
      patch(_key, patcher as unknown as CachePatcher<never>);
    },
  };
  return { adapter, invalidate, patch };
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
      tags: [],
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

    // Patcher must handle undefined prev (749992c1).
    const built = patcher(undefined);
    expect(built).toHaveLength(1);
    expect(built[0]?.id).toBe("01MSG");

    // And with an existing list, append.
    const existing = patcher([msg]);
    expect(existing).toHaveLength(1);
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

  it("delegates unknown frame types to onUnknownFrame", () => {
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
