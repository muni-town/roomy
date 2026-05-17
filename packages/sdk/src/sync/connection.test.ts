/**
 * Unit tests for SyncConnection. Uses an in-memory mock WebSocket so we can
 * drive open/message/close/error events synchronously and assert on the
 * reconnect state machine, sub/unsub message serialisation, and frame
 * decoding without touching the network.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { encode } from "@atcute/cbor";
import {
  SyncConnection,
  decodeCborFrame,
  type SyncFrame,
} from "./connection";

// ─── Mock WebSocket ───────────────────────────────────────────────────────

type ReadyState = 0 | 1 | 2 | 3;

interface MockSocket {
  url: string;
  readyState: ReadyState;
  binaryType: string;
  sent: string[];
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: (data: string) => void;
  close: () => void;
  /** Test helpers — not part of the WebSocket spec. */
  _open: () => void;
  _emitMessage: (data: ArrayBuffer | string) => void;
  _emitClose: (code?: number, reason?: string) => void;
  _emitError: () => void;
}

let lastSocket: MockSocket | null = null;
const sockets: MockSocket[] = [];

function makeMockWS(): typeof WebSocket {
  const ctor = function (this: MockSocket, url: string) {
    const self = this;
    self.url = url;
    self.readyState = 0; // CONNECTING
    self.binaryType = "blob";
    self.sent = [];
    self.onopen = null;
    self.onmessage = null;
    self.onclose = null;
    self.onerror = null;
    self.send = (data: string) => {
      if (self.readyState !== 1) throw new Error("send on non-open socket");
      self.sent.push(data);
    };
    self.close = () => {
      if (self.readyState === 3) return;
      self.readyState = 2;
      queueMicrotask(() => self._emitClose(1000, "normal"));
    };
    self._open = () => {
      self.readyState = 1;
      self.onopen?.(new Event("open"));
    };
    self._emitMessage = (data: ArrayBuffer | string) => {
      self.onmessage?.({ data } as MessageEvent);
    };
    self._emitClose = (code = 1006, reason = "") => {
      self.readyState = 3;
      self.onclose?.({ code, reason } as CloseEvent);
    };
    self._emitError = () => {
      self.onerror?.(new Event("error"));
    };
    lastSocket = self;
    sockets.push(self);
  } as unknown as typeof WebSocket;
  // Provide the readyState constants the SUT reads from the constructor.
  (ctor as unknown as { OPEN: number }).OPEN = 1;
  (ctor as unknown as { CONNECTING: number }).CONNECTING = 0;
  (ctor as unknown as { CLOSING: number }).CLOSING = 2;
  (ctor as unknown as { CLOSED: number }).CLOSED = 3;
  return ctor;
}

function buildFrame(t: string, body: Record<string, unknown>): ArrayBuffer {
  const header = encode({ t });
  const bodyBytes = encode(body);
  const out = new Uint8Array(header.byteLength + bodyBytes.byteLength);
  out.set(header, 0);
  out.set(bodyBytes, header.byteLength);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  lastSocket = null;
  sockets.length = 0;
});

describe("decodeCborFrame", () => {
  it("decodes header + body", () => {
    const buf = buildFrame("#messageDiff", { roomId: "r1", seq: 7 });
    const { header, body } = decodeCborFrame(buf);
    expect(header).toEqual({ t: "#messageDiff" });
    expect(body).toEqual({ roomId: "r1", seq: 7 });
  });

  it("returns empty body when remainder is empty", () => {
    const header = encode({ t: "#ping" });
    const { header: h, body } = decodeCborFrame(
      header.buffer.slice(header.byteOffset, header.byteOffset + header.byteLength),
    );
    expect(h).toEqual({ t: "#ping" });
    expect(body).toEqual({});
  });
});

describe("SyncConnection — open + frame emission", () => {
  it("fetches a ticket, opens the socket, and emits decoded frames", async () => {
    const fetchTicket = vi.fn().mockResolvedValue("tkt-123");
    const conn = new SyncConnection({
      fetchTicket,
      wsUrl: "wss://srv/xrpc/space.roomy.sync.subscribe",
      webSocketImpl: makeMockWS(),
    });

    const frames: SyncFrame[] = [];
    conn.onFrame((f) => frames.push(f));

    const openSpy = vi.fn();
    conn.onOpen(openSpy);

    const promise = conn.connect();
    await Promise.resolve(); // let ticket fetch resolve
    await Promise.resolve();
    expect(fetchTicket).toHaveBeenCalledOnce();
    expect(lastSocket).toBeTruthy();
    expect(lastSocket!.url).toBe(
      "wss://srv/xrpc/space.roomy.sync.subscribe?ticket=tkt-123",
    );
    expect(lastSocket!.binaryType).toBe("arraybuffer");

    lastSocket!._open();
    await promise;

    expect(conn.status.state).toBe("open");
    expect(openSpy).toHaveBeenCalledOnce();

    lastSocket!._emitMessage(buildFrame("#invalidate", { nsid: "x" }));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.header).toEqual({ t: "#invalidate" });
    expect(frames[0]!.body).toEqual({ nsid: "x" });
  });

  it("appends ticket with & when wsUrl already has a query", async () => {
    const conn = new SyncConnection({
      fetchTicket: async () => "t",
      wsUrl: "wss://srv/xrpc/foo?bar=1",
      webSocketImpl: makeMockWS(),
    });
    const p = conn.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(lastSocket!.url).toBe("wss://srv/xrpc/foo?bar=1&ticket=t");
    lastSocket!._open();
    await p;
  });
});

describe("SyncConnection — intentional close", () => {
  it("does not reconnect after close()", async () => {
    const fetchTicket = vi.fn().mockResolvedValue("t");
    const reconnectDelay = vi.fn().mockReturnValue(10);
    const conn = new SyncConnection({
      fetchTicket,
      wsUrl: "wss://srv/",
      webSocketImpl: makeMockWS(),
      reconnectDelay,
    });
    const closeSpy = vi.fn();
    conn.onClose(closeSpy);

    const p = conn.connect();
    await Promise.resolve();
    await Promise.resolve();
    lastSocket!._open();
    await p;

    conn.close();
    // Mock socket schedules close via microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(closeSpy.mock.calls[0]![0].intentional).toBe(true);
    expect(conn.status.state).toBe("closed");
    expect(reconnectDelay).not.toHaveBeenCalled();
    // Wait a bit longer than the would-be delay; no new socket should appear.
    await new Promise((r) => setTimeout(r, 25));
    expect(sockets).toHaveLength(1);
  });
});

describe("SyncConnection — abnormal close + reconnect", () => {
  it("reconnects after backoff on abnormal close", async () => {
    vi.useFakeTimers();
    try {
      const fetchTicket = vi.fn().mockResolvedValue("t");
      const conn = new SyncConnection({
        fetchTicket,
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 50,
      });

      const closeSpy = vi.fn();
      conn.onClose(closeSpy);

      const p = conn.connect();
      // Drain microtasks for the ticket fetch.
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;

      // Simulate abnormal close (network drop).
      lastSocket!._emitClose(1006, "abnormal");
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(closeSpy.mock.calls[0]![0].intentional).toBe(false);
      expect(conn.status.state).toBe("reconnecting");

      // Advance past the backoff; reconnect should fire and create a new socket.
      await vi.advanceTimersByTimeAsync(60);
      // Let the async ticket fetch resolve.
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      expect(fetchTicket).toHaveBeenCalledTimes(2);

      lastSocket!._open();
      expect(conn.status.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect when reconnectDelay returns 0", async () => {
    const conn = new SyncConnection({
      fetchTicket: async () => "t",
      wsUrl: "wss://srv/",
      webSocketImpl: makeMockWS(),
      reconnectDelay: () => 0,
    });
    const p = conn.connect();
    await Promise.resolve();
    await Promise.resolve();
    lastSocket!._open();
    await p;

    lastSocket!._emitClose(1006, "drop");
    expect(conn.status.state).toBe("closed");
    expect((conn.status as { intentional: boolean }).intentional).toBe(false);
  });
});

describe("SyncConnection — subscribe/unsubscribe", () => {
  it("serialises {type, topic, id} as JSON", async () => {
    const conn = new SyncConnection({
      fetchTicket: async () => "t",
      wsUrl: "wss://srv/",
      webSocketImpl: makeMockWS(),
    });
    const p = conn.connect();
    await Promise.resolve();
    await Promise.resolve();
    lastSocket!._open();
    await p;

    conn.subscribe({ kind: "space", id: "abc" });
    conn.subscribe({ kind: "room", id: "xyz" });
    conn.unsubscribe({ kind: "space", id: "abc" });

    expect(lastSocket!.sent).toEqual([
      JSON.stringify({ type: "sub", topic: "space", id: "abc" }),
      JSON.stringify({ type: "sub", topic: "room", id: "xyz" }),
      JSON.stringify({ type: "unsub", topic: "space", id: "abc" }),
    ]);

    expect(conn.subscribedTopics).toEqual([{ kind: "room", id: "xyz" }]);
  });

  it("queues subscribes when called before open and flushes on open", async () => {
    const conn = new SyncConnection({
      fetchTicket: async () => "t",
      wsUrl: "wss://srv/",
      webSocketImpl: makeMockWS(),
    });
    conn.subscribe({ kind: "room", id: "r1" });
    conn.subscribe({ kind: "space", id: "s1" });

    const p = conn.connect();
    await Promise.resolve();
    await Promise.resolve();
    expect(lastSocket!.sent).toEqual([]); // not yet open
    lastSocket!._open();
    await p;

    expect(lastSocket!.sent).toEqual([
      JSON.stringify({ type: "sub", topic: "room", id: "r1" }),
      JSON.stringify({ type: "sub", topic: "space", id: "s1" }),
    ]);
  });
});

describe("SyncConnection — re-subscription on reconnect", () => {
  it("re-sends all tracked topics on the new socket", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SyncConnection({
        fetchTicket: async () => "t",
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 10,
      });

      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;

      conn.subscribe({ kind: "room", id: "r1" });
      conn.subscribe({ kind: "space", id: "s1" });
      const firstSocket = lastSocket!;
      expect(firstSocket.sent).toHaveLength(2);

      // Drop the connection.
      firstSocket._emitClose(1006, "drop");
      await vi.advanceTimersByTimeAsync(15);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      const secondSocket = lastSocket!;
      expect(secondSocket).not.toBe(firstSocket);

      // Topics should re-fire on open.
      secondSocket._open();
      expect(secondSocket.sent).toEqual([
        JSON.stringify({ type: "sub", topic: "room", id: "r1" }),
        JSON.stringify({ type: "sub", topic: "space", id: "s1" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SyncConnection — error handling", () => {
  it("forwards a generic error from onerror to onError handlers", async () => {
    const conn = new SyncConnection({
      fetchTicket: async () => "t",
      wsUrl: "wss://srv/",
      webSocketImpl: makeMockWS(),
    });
    const errs: unknown[] = [];
    conn.onError((e) => errs.push(e));
    const p = conn.connect().catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    lastSocket!._emitError();
    await p;
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe("WebSocket error");
  });

  it("forwards ticket-fetch failure and schedules reconnect", async () => {
    vi.useFakeTimers();
    try {
      const fetchTicket = vi
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce("tkt");
      const conn = new SyncConnection({
        fetchTicket,
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 5,
      });
      const errs: unknown[] = [];
      conn.onError((e) => errs.push(e));

      await conn.connect().catch(() => {});
      expect(errs).toHaveLength(1);
      expect(conn.status.state).toBe("reconnecting");

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchTicket).toHaveBeenCalledTimes(2);
      expect(lastSocket).toBeTruthy();
      lastSocket!._open();
      expect(conn.status.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});
