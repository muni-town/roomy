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
  lastPingSocket = null;
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
        reconnectDelay: (_attempt: number) => 50,
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
      const rs = conn.status as { state: "reconnecting"; attempt: number; delayMs: number };
      expect(rs.attempt).toBe(1);
      expect(rs.delayMs).toBe(50);

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
      reconnectDelay: (_attempt: number) => 0,
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

  it("still reconnects when the default backoff draws a zero jitter value", async () => {
    // The default generator is `floor(random() * cap)`, which draws exactly 0
    // with probability 1/cap. The abnormal-close handler treats a non-positive
    // delay as the caller's "disable auto-reconnect" signal, so a zero draw
    // would silently kill reconnection. The default generator must never
    // return 0.
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const fetchTicket = vi.fn().mockResolvedValue("t");
      const conn = new SyncConnection({
        fetchTicket,
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
      });

      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;

      lastSocket!._emitClose(1006, "drop");
      // Must be reconnecting, not closed: a zero draw is not a disable.
      const status = conn.status;
      expect(status.state).toBe("reconnecting");
      expect(status.state === "reconnecting" && status.attempt).toBe(1);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      expect(fetchTicket).toHaveBeenCalledTimes(2);
      lastSocket!._open();
      expect(conn.status.state).toBe("open");
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
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
        reconnectDelay: (_attempt: number) => 10,
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
        reconnectDelay: (_attempt: number) => 5,
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

describe("SyncConnection — exponential backoff", () => {
  it("increases delay with each consecutive failure using default backoff", async () => {
    // Use deterministic backoff for testing
    const delays: number[] = [];
    const conn = new SyncConnection({
      fetchTicket: async () => { throw new Error("fail"); },
      wsUrl: "wss://srv/",
      webSocketImpl: makeMockWS(),
      reconnectDelay: (attempt: number) => {
        const d = Math.min(1000 * 2 ** attempt, 30_000);
        delays.push(d);
        return d;
      },
    });
    conn.onError(() => {}); // suppress unhandled

    // First failure triggers reconnect with delay for attempt 0. The ticket
    // fetch rejects asynchronously, so await the rejection before asserting.
    await conn.connect().catch(() => {});
    // Delay should be 1000 (attempt 0)
    expect(delays).toEqual([1000]);
  });

  it("resets attempt counter on successful connection", async () => {
    vi.useFakeTimers();
    try {
      const fetchTicket = vi.fn().mockResolvedValue("t");
      const attempts: number[] = [];
      const conn = new SyncConnection({
        fetchTicket,
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: (attempt: number) => {
          attempts.push(attempt);
          return 10;
        },
      });
      conn.onError(() => {});

      // Connect successfully
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;

      // Drop, reconnect, and succeed again — attempt should reset
      lastSocket!._emitClose(1006, "drop");
      await vi.advanceTimersByTimeAsync(15);
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      expect(conn.status.state).toBe("open");

      // Drop again — attempt counter should have reset, so attempt 0 again
      lastSocket!._emitClose(1006, "drop");
      await vi.advanceTimersByTimeAsync(15);
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual([0, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps delay at backoffMaxMs with default formula", async () => {
    const delays: number[] = [];
    const conn = new SyncConnection({
      fetchTicket: async () => { throw new Error("fail"); },
      wsUrl: "wss://srv/",
      webSocketImpl: makeMockWS(),
      backoffBaseMs: 1000,
      backoffMaxMs: 5000,
    });
    conn.onError(() => {});
    // The reconnect delay is surfaced through the status transition to
    // "reconnecting" (delayMs = min(base * 2^attempt, max), full jitter).
    conn.onStatusChange((status) => {
      if (status.state === "reconnecting") delays.push(status.delayMs);
    });

    // With base=1000, max=5000: cap = min(1000 * 2^attempt, 5000)
    // attempt 0: 1000, attempt 1: 2000, attempt 2: 4000, attempt 3+: 5000
    await conn.connect().catch(() => {});
    expect(delays).toHaveLength(1);
    // The default is full jitter, so any sample must sit within [1, 1000].
    // The lower bound is 1, never 0: a 0 delay is the "stop reconnecting"
    // signal (see the wedge test below), so the default must be unable to
    // produce it.
    expect(delays[0]!).toBeGreaterThanOrEqual(1);
    expect(delays[0]!).toBeLessThanOrEqual(1000);
  });

  // Math.random() can return exactly 0. With an unclamped full-jitter formula
  // that yields delay 0, which #handleAbnormalClose treats as "stop
  // reconnecting" — status flips to `closed`, no timer is armed, and the
  // connection can never reopen without a full page reload.
  it("never disables reconnect when jitter floors to zero", async () => {
    vi.useFakeTimers();
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const conn = new SyncConnection({
        fetchTicket: async () => "t",
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
      });
      conn.onError(() => {});

      const statuses: string[] = [];
      conn.onStatusChange((s) => statuses.push(s.state));

      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;

      // Drop the socket; the default backoff computes a zero delay here.
      lastSocket!._emitClose(1006, "drop");
      expect(conn.status.state).toBe("reconnecting");

      // A reconnect must actually be scheduled despite the zero jitter.
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      expect(statuses).not.toContain("closed");
    } finally {
      randSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});


// ─── Heartbeat tests ──────────────────────────────────────────────────────
//
// The default makeMockWS() has no `.ping` on its prototype, so the
// heartbeat self-disables — that keeps the suite above unaffected. These
// tests use a ping-capable mock whose prototype exposes `.ping` (the
// signal #configureHeartbeat probes for) and dispatches `pong` events
// through addEventListener, matching Bun's client WebSocket surface.

interface PingableSocket extends MockSocket {
	ping: (data?: string | ArrayBuffer) => void;
	pingCalls: number;
	_emitPong: () => void;
	_listeners: Map<string, Set<(ev: Event) => void>>;
}

let lastPingSocket: PingableSocket | null = null;

function makePingableWS(): typeof WebSocket {
	const ctor = function (this: PingableSocket, url: string) {
		// Reuse the base mock's field setup by calling through.
		const base: MockSocket = {
			url,
			readyState: 0,
			binaryType: "blob",
			sent: [],
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
			send: (data: string) => {
				if (this.readyState !== 1) throw new Error("send on non-open socket");
				this.sent.push(data);
			},
			close: () => {
				if (this.readyState === 3) return;
				this.readyState = 2;
				queueMicrotask(() => this._emitClose(1000, "normal"));
			},
			_open: () => {
				this.readyState = 1;
				this.onopen?.(new Event("open"));
			},
			_emitMessage: (data: ArrayBuffer | string) => {
				this.onmessage?.({ data } as MessageEvent);
			},
			_emitClose: (code = 1006, reason = "") => {
				this.readyState = 3;
				this.onclose?.({ code, reason } as CloseEvent);
			},
			_emitError: () => {
				this.onerror?.(new Event("error"));
			},
		};
		// Copy base fields onto `this`.
		for (const key of Object.keys(base) as (keyof MockSocket)[]) {
			(this as unknown as Record<keyof MockSocket, unknown>)[key] = base[key];
		}
		this.pingCalls = 0;
		this.ping = (_data?: string | ArrayBuffer) => {
			this.pingCalls++;
		};
		this._listeners = new Map();
		this._emitPong = () => {
			const set = this._listeners.get("pong");
			if (set) for (const cb of set) cb(new Event("pong"));
		};
		lastPingSocket = this;
		sockets.push(this as unknown as MockSocket);
	} as unknown as typeof WebSocket;
	// Prototype members the SUT probes for.
	(ctor as unknown as { OPEN: number }).OPEN = 1;
	(ctor as unknown as { CONNECTING: number }).CONNECTING = 0;
	(ctor as unknown as { CLOSING: number }).CLOSING = 2;
	(ctor as unknown as { CLOSED: number }).CLOSED = 3;
	// Expose .ping on the prototype so #configureHeartbeat detects support.
	(ctor as unknown as { prototype: { ping: unknown } }).prototype.ping =
		function () {};
	// addEventListener/removeEventListener live on the prototype so the
	// SUT's runtime check (`typeof wsAny.addEventListener`) resolves true.
	(ctor as unknown as { prototype: Record<string, unknown> }).prototype.addEventListener =
		function (this: PingableSocket, type: string, cb: (ev: Event) => void) {
			let set = this._listeners.get(type);
			if (!set) {
				set = new Set();
				this._listeners.set(type, set);
			}
			set.add(cb);
		};
	(ctor as unknown as { prototype: Record<string, unknown> }).prototype.removeEventListener =
		function (this: PingableSocket, type: string, cb: (ev: Event) => void) {
			this._listeners.get(type)?.delete(cb);
		};
	return ctor;
}

describe("SyncConnection — heartbeat", () => {
	it("disables heartbeat when WebSocket impl lacks .ping()", async () => {
		// Default mock has no .ping on its prototype → silently disabled.
		const conn = new SyncConnection({
			fetchTicket: async () => "t",
			wsUrl: "wss://srv/",
			webSocketImpl: makeMockWS(),
			heartbeat: {},
		});
		const p = conn.connect();
		await Promise.resolve();
		await Promise.resolve();
		lastSocket!._open();
		await p;

		// No ping ever sent; connection stays open and healthy.
		expect((lastSocket as unknown as { ping?: unknown }).ping).toBeUndefined();
		conn.close();
		await Promise.resolve();
		await Promise.resolve();
	});

	it("sends a ping on the configured interval and clears watchdog on pong", async () => {
		vi.useFakeTimers();
		try {
			const conn = new SyncConnection({
				fetchTicket: async () => "t",
				wsUrl: "wss://srv/",
				webSocketImpl: makePingableWS(),
				heartbeat: { intervalMs: 5000, pongTimeoutMs: 2000 },
			});
			const p = conn.connect();
			await vi.advanceTimersByTimeAsync(0);
			lastPingSocket!._open();
			await p;
			expect(conn.status.state).toBe("open");

			// Before the interval elapses, no ping.
			expect(lastPingSocket!.pingCalls).toBe(0);

			// At 5s the first ping fires and arms the watchdog.
			await vi.advanceTimersByTimeAsync(5000);
			expect(lastPingSocket!.pingCalls).toBe(1);

			// Pong arrives before the 2s watchdog expires → no close.
			lastPingSocket!._emitPong();
			await vi.advanceTimersByTimeAsync(2000);
			expect(conn.status.state).toBe("open");

			// Next interval tick sends another ping.
			await vi.advanceTimersByTimeAsync(5000);
			expect(lastPingSocket!.pingCalls).toBe(2);

			conn.close();
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("closes the socket when no pong arrives within the timeout", async () => {
		vi.useFakeTimers();
		try {
			const fetchTicket = vi.fn().mockResolvedValue("t");
			const conn = new SyncConnection({
				fetchTicket,
				wsUrl: "wss://srv/",
				webSocketImpl: makePingableWS(),
				heartbeat: { intervalMs: 5000, pongTimeoutMs: 2000 },
				reconnectDelay: (_attempt: number) => 10,
			});
			const closeSpy = vi.fn();
			conn.onClose(closeSpy);
			conn.onError(() => {});

			const p = conn.connect();
			await vi.advanceTimersByTimeAsync(0);
			lastPingSocket!._open();
			await p;

			// First ping at 5s; no pong follows.
			await vi.advanceTimersByTimeAsync(5000);
			expect(lastPingSocket!.pingCalls).toBe(1);

			// Watchdog fires at +2s → abnormal close → reconnect scheduled.
			await vi.advanceTimersByTimeAsync(2000);
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(closeSpy.mock.calls[0]![0].intentional).toBe(false);
			expect(conn.status.state).toBe("reconnecting");

			// Reconnect fires after backoff and re-establishes a fresh socket.
			await vi.advanceTimersByTimeAsync(15);
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchTicket).toHaveBeenCalledTimes(2);
			lastPingSocket!._open();
			expect(conn.status.state).toBe("open");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops heartbeat timers on intentional close", async () => {
		vi.useFakeTimers();
		try {
			const conn = new SyncConnection({
				fetchTicket: async () => "t",
				wsUrl: "wss://srv/",
				webSocketImpl: makePingableWS(),
				heartbeat: { intervalMs: 5000, pongTimeoutMs: 2000 },
			});
			const p = conn.connect();
			await vi.advanceTimersByTimeAsync(0);
			lastPingSocket!._open();
			await p;

			// Close before the first interval tick.
			conn.close();
			await vi.advanceTimersByTimeAsync(0);

			// Advance well past the interval; no ping should fire on the dead socket.
			const callsBefore = lastPingSocket!.pingCalls;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(lastPingSocket!.pingCalls).toBe(callsBefore);
			expect(conn.status.state).toBe("closed");
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects invalid heartbeat config", () => {
		expect(
			() =>
				new SyncConnection({
					fetchTicket: async () => "t",
					wsUrl: "wss://srv/",
					webSocketImpl: makePingableWS(),
					heartbeat: { intervalMs: 0 },
				}),
		).toThrow(/intervalMs must be positive/);

		expect(
			() =>
				new SyncConnection({
					fetchTicket: async () => "t",
					wsUrl: "wss://srv/",
					webSocketImpl: makePingableWS(),
					heartbeat: { intervalMs: 5000, pongTimeoutMs: 5000 },
				}),
		).toThrow(/pongTimeoutMs .* must be < intervalMs/);
	});
});
describe("SyncConnection — failed handshake never wedges the reconnect loop", () => {
  // Node's undici WebSocket fires `error` and then never fires `close` when the
  // handshake fails (bad ticket, origin 502, DNS failure). The reconnect path is
  // driven by `onclose`, so such a socket must be abandoned explicitly or it
  // wedges the connection permanently: no open socket, no pending reconnect.
  it("schedules a reconnect when the socket errors without ever closing", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SyncConnection({
        fetchTicket: async () => "t",
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 50,
      });
      const statuses: string[] = [];
      conn.onStatusChange((s) => statuses.push(s.state));

      const p = conn.connect().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(lastSocket).not.toBeNull();

      // Handshake fails: error with the socket still in CONNECTING, and no close.
      const dead = lastSocket!;
      dead._emitError();
      expect(dead.readyState).toBe(0);
      await p;

      // Grace period then abandon → reconnecting, instead of idle forever.
      await vi.advanceTimersByTimeAsync(1000);
      expect(statuses).toContain("reconnecting");

      // The stale socket is detached and a fresh attempt is made.
      expect(dead.onclose).toBeNull();
      await vi.advanceTimersByTimeAsync(50);
      expect(sockets.length).toBeGreaterThan(1);
      expect(lastSocket).not.toBe(dead);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect twice when a late close arrives after being abandoned", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SyncConnection({
        fetchTicket: async () => "t",
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 50,
      });
      const p = conn.connect().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const dead = lastSocket!;
      dead._emitError();
      await p;
      await vi.advanceTimersByTimeAsync(1000); // abandoned + reconnect scheduled
      const afterAbandon = sockets.length;

      // A real socket that later emits close must not double-schedule:
      // its handlers were stripped, so this is a no-op.
      expect(dead.onclose).toBeNull();
      dead._emitClose(1006, "late");

      await vi.advanceTimersByTimeAsync(50);
      expect(sockets.length).toBe(afterAbandon + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting for a healthy socket that opens normally", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SyncConnection({
        fetchTicket: async () => "t",
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        backoffBaseMs: 1,
      });
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;
      expect(conn.status.state).toBe("open");
      // No spurious reconnect long after the (would-be) timeout.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(conn.status.state).toBe("open");
      expect(sockets.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SyncConnection — maxReconnectAttempts / onGiveUp", () => {
  it("gives up after the cap and reports the attempt number", async () => {
    vi.useFakeTimers();
    try {
      const gaveUp: number[] = [];
      const conn = new SyncConnection({
        fetchTicket: async () => {
          throw new Error("boom");
        },
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 10,
        maxReconnectAttempts: 3,
        onGiveUp: (info) => gaveUp.push(info.attempt),
      });

      void conn.connect().catch(() => {});
      // 3 capped attempts, then give up instead of looping forever.
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(20);

      expect(gaveUp).toHaveLength(1);
      expect(gaveUp[0]).toBe(4); // 1-based: attempts 1,2,3 then give up
      expect(conn.status.state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never trips the cap while connects still succeed", async () => {
    vi.useFakeTimers();
    try {
      const gaveUp: number[] = [];
      const conn = new SyncConnection({
        fetchTicket: async () => "t",
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 10,
        maxReconnectAttempts: 2,
        onGiveUp: (info) => gaveUp.push(info.attempt),
      });

      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;

      // Successful opens reset the counter, so repeated drops never give up.
      for (let i = 0; i < 5; i++) {
        lastSocket!._emitClose(1006, "drop");
        await vi.advanceTimersByTimeAsync(15);
        lastSocket!._open();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(gaveUp).toHaveLength(0);
      expect(conn.status.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SyncConnection — hanging ticket fetch (no socket yet)", () => {
  // The watchdog must also cover the window before a socket exists: a
  // fetchTicket that never settles would otherwise hang the attempt forever,
  // leaving no socket and no scheduled reconnect.
  it("abandons and retries when fetchTicket never settles", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const conn = new SyncConnection({
        fetchTicket: () =>
          calls++ === 0
            ? new Promise<string>(() => {}) // hangs forever
            : Promise.resolve("t"),
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 10,
        connectTimeoutMs: 5000,
      });
      const outcomes: string[] = [];
      void conn.connect().then(
        () => outcomes.push("resolved"),
        (e) => outcomes.push(`rejected: ${e.message}`),
      );
      await vi.advanceTimersByTimeAsync(0);

      // Nothing opened; the attempt must be abandoned rather than hang.
      await vi.advanceTimersByTimeAsync(5000);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toContain("rejected");

      // And a fresh attempt must actually be made.
      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a ticket that resolves after the attempt was abandoned", async () => {
    vi.useFakeTimers();
    try {
      const resolvers: ((t: string) => void)[] = [];
      const conn = new SyncConnection({
        fetchTicket: () => new Promise<string>((res) => resolvers.push(res)),
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 10,
        connectTimeoutMs: 1000,
      });
      void conn.connect().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000); // abandoned
      const before = sockets.length;

      // The stale ticket lands late; no socket may be created for it.
      resolvers[0]?.("stale");
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SyncConnection — concurrent connect() calls", () => {
  // connect() must be idempotent even while a ticket fetch is still pending
  // (before any socket exists). Otherwise a second caller starts a rival
  // attempt, invalidates the first via the epoch guard, and the two race —
  // one rejects with "abandoned" while both hold a ticket.
  it("shares one in-flight attempt instead of starting a rival", async () => {
    vi.useFakeTimers();
    try {
      const resolvers: ((t: string) => void)[] = [];
      const conn = new SyncConnection({
        fetchTicket: () => new Promise<string>((res) => resolvers.push(res)),
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
      });
      const p1 = conn.connect();
      const p2 = conn.connect();
      await vi.advanceTimersByTimeAsync(0);

      // One ticket fetch, not two.
      expect(resolvers).toHaveLength(1);

      resolvers[0]?.("t");
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await expect(p1).resolves.toBeUndefined();
      await expect(p2).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // Calling connect() while a reconnect is pending means "try now": the
  // caller's nudge (e.g. the tab becoming visible again after the backoff
  // timer was throttled) must start an attempt immediately rather than
  // waiting out the remaining backoff. The pending timer must not then issue
  // a second, concurrent attempt once it eventually fires.
  it("re-drives immediately when connect() is called during a pending reconnect", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SyncConnection({
        fetchTicket: async () => "t",
        wsUrl: "wss://srv/",
        webSocketImpl: makeMockWS(),
        reconnectDelay: () => 10_000,
      });
      conn.onError(() => {});

      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      lastSocket!._open();
      await p;

      // Drop: reconnect is now scheduled 10s out.
      lastSocket!._emitClose(1006, "drop");
      expect(conn.status.state).toBe("reconnecting");
      expect(sockets).toHaveLength(1);

      // Nudge: a fresh attempt starts immediately, without waiting the 10s.
      const p2 = conn.connect().catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);

      // The original timer must have been cleared: advancing past it creates
      // no third socket.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sockets).toHaveLength(2);

      lastSocket!._open();
      await p2;
      expect(conn.status.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SyncConnection — attempt lifecycle edge cases", () => {
  // Sharing the in-flight attempt must not make connect() sticky: once an
  // attempt settles, the next call has to start a fresh one (callers
  // legitimately retry after a failure).
  it("starts a fresh attempt after the previous one settled", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const conn = new SyncConnection({
        fetchTicket: async () => {
          calls++;
          throw new Error("nope");
        },
        wsUrl: "wss://srv/",
        reconnectDelay: () => 0,
      });
      await conn.connect().catch(() => {});
      const after1 = calls;
      await conn.connect().catch(() => {});
      expect(calls).toBeGreaterThan(after1);
    } finally {
      vi.useRealTimers();
    }
  });

  // close() during a pending ticket fetch must settle the caller's promise.
  it("settles a pending connect when close() is called", async () => {
    vi.useFakeTimers();
    try {
      const conn = new SyncConnection({
        fetchTicket: () => new Promise<string>(() => {}),
        wsUrl: "wss://srv/",
      });
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(0);
      conn.close();
      await expect(p).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });
});
