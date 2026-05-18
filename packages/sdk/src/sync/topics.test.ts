import { describe, expect, it, vi } from "vitest";
import type { SyncConnection, Topic } from "./connection";
import { TopicManager } from "./topics";

function mockConnection(): {
  conn: Pick<SyncConnection, "subscribe" | "unsubscribe">;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const subscribe = vi.fn((_t: Topic) => {});
  const unsubscribe = vi.fn((_t: Topic) => {});
  return { conn: { subscribe, unsubscribe }, subscribe, unsubscribe };
}

const ROOM: Topic = { kind: "room", id: "01ROOM" };
const SPACE: Topic = { kind: "space", id: "01SPACE" };

describe("TopicManager", () => {
  it("first acquire sends subscribe; subsequent acquires do not", () => {
    const { conn, subscribe } = mockConnection();
    const mgr = new TopicManager(conn as SyncConnection);

    mgr.acquire(ROOM);
    mgr.acquire(ROOM);
    mgr.acquire(ROOM);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]?.[0]).toEqual(ROOM);
    expect(mgr.refcount(ROOM)).toBe(3);
  });

  it("last release sends unsubscribe; earlier releases do not", () => {
    const { conn, subscribe, unsubscribe } = mockConnection();
    const mgr = new TopicManager(conn as SyncConnection);

    const dispose1 = mgr.acquire(ROOM);
    const dispose2 = mgr.acquire(ROOM);
    const dispose3 = mgr.acquire(ROOM);

    dispose1();
    expect(unsubscribe).not.toHaveBeenCalled();
    dispose2();
    expect(unsubscribe).not.toHaveBeenCalled();
    dispose3();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe.mock.calls[0]?.[0]).toEqual(ROOM);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(mgr.refcount(ROOM)).toBe(0);
  });

  it("disposers are idempotent", () => {
    const { conn, unsubscribe } = mockConnection();
    const mgr = new TopicManager(conn as SyncConnection);

    const dispose = mgr.acquire(ROOM);
    dispose();
    dispose();
    dispose();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mgr.refcount(ROOM)).toBe(0);
  });

  it("tracks distinct topics independently", () => {
    const { conn, subscribe, unsubscribe } = mockConnection();
    const mgr = new TopicManager(conn as SyncConnection);

    const r1 = mgr.acquire(ROOM);
    const s1 = mgr.acquire(SPACE);
    expect(subscribe).toHaveBeenCalledTimes(2);

    r1();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(mgr.refcount(SPACE)).toBe(1);

    s1();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("re-acquiring after full release re-subscribes", () => {
    const { conn, subscribe, unsubscribe } = mockConnection();
    const mgr = new TopicManager(conn as SyncConnection);

    mgr.acquire(ROOM)();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    mgr.acquire(ROOM);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});
