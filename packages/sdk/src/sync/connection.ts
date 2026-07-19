/**
 * Framework-agnostic WebSocket sync connection for the Roomy appserver.
 *
 * Manages the lifecycle of a single WebSocket connection to the appserver's
 * `space.roomy.sync.subscribe` endpoint:
 *
 *  - Ticket-based auth: callers provide a `fetchTicket` function (typically
 *    wrapping the `space.roomy.auth.getConnectionTicket` procedure). The
 *    ticket is appended as a query param to the WS URL.
 *  - Reconnect-with-exponential-backoff: on abnormal close, reconnects after
 *    an exponentially increasing delay with jitter. The initial attempt waits
 *    ~1–2 s, doubling each time up to a configurable max (default 30 s).
 *    The attempt counter resets on a successful open. Intentional `close()`
 *    calls disable reconnection entirely.
 *  - CBOR frame decoding: binary frames are decoded via `@atcute/cbor`'s
 *    `decodeFirst` (header + body). Frames are surfaced through `onFrame`
 *    without interpretation — frame-type routing belongs to a higher layer
 *    (see Slice 6 in the SDK thin-client extraction plan).
 *  - Topic resubscription: the set of currently-subscribed topics is tracked
 *    in memory; on reconnect, all topics are re-sent automatically.
 *
 * No Svelte, no DOM-only globals beyond the WebSocket constructor (which is
 * available in modern Node, browsers, and Deno). A custom constructor may
 * be injected via `webSocketImpl` for testing.
 */

import { decodeFirst } from "@atcute/cbor";

// ─── Public types ─────────────────────────────────────────────────────────

export type TopicKind = "space" | "room" | "stream";

export interface Topic {
  kind: TopicKind;
  id: string;
  /**
   * Exclusive cursor for `stream` topics: the last-delivered event idx.
   * The server backfills events with idx > cursor, then streams live
   * events. Use -1 for full backfill from the beginning of the stream.
   * Ignored for `space` and `room` topics.
   */
  cursor?: number;
}

export interface SyncFrame {
  /** Decoded CBOR header (typically `{ t: "#frameType" }`). */
  header: Record<string, unknown>;
  /** Decoded CBOR body (frame-type-specific payload). Empty object if absent. */
  body: Record<string, unknown>;
  /** Original raw bytes, for callers that want to re-decode or hash. */
  raw: ArrayBuffer;
}

export type ConnectionStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "open" }
  | { state: "reconnecting"; delayMs: number; attempt: number }
  | { state: "closing" }
  | { state: "closed"; intentional: boolean; code?: number; reason?: string };

export interface CloseEventInfo {
  code: number;
  reason: string;
  intentional: boolean;
}

export interface ConnectionLogger {
  (msg: string): void;
}

export interface SyncConnectionOptions {
  /**
   * Mints a fresh connection ticket. Called on every connect attempt
   * (initial + each reconnect) because tickets are single-use / short-lived.
   */
  fetchTicket: () => Promise<string>;
  /**
   * WS URL **without** the ticket query param. The connection appends
   * `?ticket=<encoded>` (or `&ticket=…` if the URL already has a query).
   * Example: `wss://appserver.example/xrpc/space.roomy.sync.subscribe`
   */
  wsUrl: string;
  /** Optional logger; receives human-readable status lines. */
  logger?: ConnectionLogger;
  /**
   * Override the WebSocket constructor. Defaults to the global `WebSocket`.
   * Used by tests to inject a mock; in Node ≥ 22 the global is available.
   */
  webSocketImpl?: typeof WebSocket;
  /**
   * Override the reconnect-delay calculator. Receives the 0-based
   * consecutive-failure attempt number and must return a delay in ms.
   * Return a non-positive number to disable auto-reconnect for that attempt.
   *
   * Defaults to exponential backoff with full jitter:
   * `min(baseDelay * 2^attempt, maxDelay) * random()`
   */
  reconnectDelay?: (attempt: number) => number;
  /**
   * Base delay for the default exponential backoff (ms).
   * Default: 1000 (1 second).
   */
  backoffBaseMs?: number;
  /**
   * Maximum delay cap for the default exponential backoff (ms).
   * Default: 30000 (30 seconds).
   */
  backoffMaxMs?: number;
  /**
   * Heartbeat configuration. When set, the connection sends a WebSocket
   * protocol-level `ping` frame on an interval and reconnects if no `pong`
   * arrives within the timeout window. This keeps idle connections alive
   * through proxies and load balancers that would otherwise drop them, and
   * detects half-open sockets faster than relying on TCP keepalive alone.
   *
   * Uses RFC 6455 control frames: the server is required to auto-reply with
   * a `pong`, so no appserver cooperation is needed. Only enable where the
   * underlying `WebSocket` implementation exposes `.ping()` and emits
   * `pong` events (Bun, Node ≥ 21). Browsers don't expose ping/pong to JS,
   * so this option is a no-op there unless `webSocketImpl` is overridden.
   *
   * Disabled by default. Pass an empty object to enable with defaults
   * (30s interval, 10s pong timeout). `heartbeat.enabled: false` forces it
   * off regardless of other fields.
   */
  heartbeat?: {
    /** Enable the heartbeat. Defaults to true when the object is passed. */
    enabled?: boolean;
    /** Time between ping frames in ms. Default: 30_000 (30s). */
    intervalMs?: number;
    /**
     * How long to wait for a pong before declaring the connection dead and
     * triggering an abnormal-close reconnect, in ms. Default: 10_000 (10s).
     * Must be less than `intervalMs` to avoid racing the next ping.
     */
    pongTimeoutMs?: number;
  };
}

export type Unsubscribe = () => void;

// ─── Implementation ───────────────────────────────────────────────────────

type AnyWebSocket = WebSocket;

/**
 * Duck-typed WebSocket surface for protocol-level ping/pong. The DOM
 * `WebSocket` type hides these (browsers don't expose them to JS), but Bun
 * and Node ≥ 21 implement them. Used only after #configureHeartbeat has
 * confirmed the constructor's prototype carries `.ping`.
 */
interface PingableWebSocket {
  readyState: number;
  ping(data?: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: "pong", cb: (ev: Event) => void): void;
  removeEventListener?(type: "pong", cb: (ev: Event) => void): void;
  onpong?: ((ev: Event) => void) | null;
}

const TOPIC_KEY = (t: Topic) => `${t.kind}:${t.id}`;

/**
 * A framework-agnostic appserver sync connection.
 *
 * Lifecycle:
 *   `new SyncConnection(opts)` → idle
 *   `connect()` → connecting → open
 *   abnormal close → reconnecting → connecting → open …
 *   `close()` → closing → closed (intentional)
 */
export class SyncConnection {
  readonly #opts: SyncConnectionOptions;
  readonly #WS: typeof WebSocket;
  readonly #reconnectDelay: (attempt: number) => number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;

  #ws: AnyWebSocket | null = null;
  #status: ConnectionStatus = { state: "idle" };
  #intentionalClose = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive reconnect attempts since last successful open. Reset on connect. */
  #reconnectAttempt = 0;
  /** Topics the caller has asked us to be subscribed to. Replayed on reconnect. */
  readonly #topics = new Map<string, Topic>();

  readonly #frameHandlers = new Set<(frame: SyncFrame) => void>();
  readonly #openHandlers = new Set<() => void>();
  readonly #closeHandlers = new Set<(info: CloseEventInfo) => void>();
  readonly #errorHandlers = new Set<(err: unknown) => void>();
  readonly #statusHandlers = new Set<(status: ConnectionStatus) => void>();

  // ── Heartbeat ────────────────────────────────────────────────────────
  /** Whether the heartbeat is enabled and supported by the WS impl. */
  #heartbeatEnabled = false;
  #heartbeatIntervalMs = 30_000;
  #heartbeatPongTimeoutMs = 10_000;
  /** Interval timer sending pings while the socket is open. */
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  /** One-shot timer waiting for a pong; fires an abnormal close if it expires. */
  #pongTimer: ReturnType<typeof setTimeout> | null = null;
  /** Listener unsubscribe for the WS impl's pong event. */
  #pongUnsubscribe: (() => void) | null = null;

  constructor(opts: SyncConnectionOptions) {
    this.#opts = opts;
    const WS = opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      throw new Error(
        "SyncConnection: no WebSocket implementation found. Pass `webSocketImpl` " +
          "or run in an environment with a global WebSocket (Node ≥ 22, browsers, Deno).",
      );
    }
    this.#WS = WS;
    this.#backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.#backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.#reconnectDelay = opts.reconnectDelay ?? ((attempt: number) => {
      const cap = Math.min(this.#backoffBaseMs * 2 ** attempt, this.#backoffMaxMs);
      // Full jitter: random value in [0, cap]
      return Math.floor(Math.random() * cap);
    });
    this.#configureHeartbeat(opts);
  }

  // ── Heartbeat ────────────────────────────────────────────────────────

  /**
   * Resolve heartbeat config. Enabled only when `opts.heartbeat` is passed
   * (or an empty object), not explicitly disabled, and the WebSocket impl
   * exposes a `.ping` method on its prototype — the reliable signal that
   * pong control frames are also observable (Bun, Node ≥ 21). Browsers
   * hide ping/pong from JS, so we silently no-op there rather than error.
   */
  #configureHeartbeat(opts: SyncConnectionOptions): void {
    const hb = opts.heartbeat;
    if (!hb) {
      this.#heartbeatEnabled = false;
      return;
    }
    if (hb.enabled === false) {
      this.#heartbeatEnabled = false;
      return;
    }
    // Probe the constructor's prototype for `.ping`. Bun and Node ≥ 21
    // expose it; browsers (and the mock WS used by tests) do not.
    const proto = this.#WS.prototype as { ping?: unknown };
    const supportsPing = typeof proto.ping === "function";
    if (!supportsPing) {
      this.#log("heartbeat requested but WebSocket impl lacks .ping() — disabled");
      this.#heartbeatEnabled = false;
      return;
    }
    const interval = hb.intervalMs ?? 30_000;
    const timeout = hb.pongTimeoutMs ?? 10_000;
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error(`SyncConnection: heartbeat.intervalMs must be positive (got ${interval})`);
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`SyncConnection: heartbeat.pongTimeoutMs must be positive (got ${timeout})`);
    }
    if (timeout >= interval) {
      throw new Error(
        `SyncConnection: heartbeat.pongTimeoutMs (${timeout}) must be < intervalMs (${interval})`,
      );
    }
    this.#heartbeatEnabled = true;
    this.#heartbeatIntervalMs = interval;
    this.#heartbeatPongTimeoutMs = timeout;
  }

  /**
   * Start the heartbeat loop on an open socket: register a pong listener,
   * schedule the first ping, and arm the pong watchdog. Must be called
   * after the socket is open and #ws is set. Idempotent.
   */
  #startHeartbeat(): void {
    if (!this.#heartbeatEnabled) return;
    const ws = this.#ws;
    if (!ws) return;
    this.#stopHeartbeatTimers();

    // Pong listener. Bun fires a `pong` Event; other impls may pass the
    // payload. Clear the pending watchdog and re-arm the next ping via
    // the interval timer (which is already running).
    this.#pongUnsubscribe = this.#addPongListener(ws, () => {
      if (this.#pongTimer) {
        clearTimeout(this.#pongTimer);
        this.#pongTimer = null;
      }
    });

    // Re-arming ping on every interval. Each tick sends a ping and arms
    // a fresh pong watchdog; the watchdog is disarmed by the pong handler.
    // The first tick is delayed by `intervalMs` so a just-opened socket
    // isn't pinged immediately.
    this.#pingTimer = setInterval(() => {
      const current = this.#ws;
      if (!current || current.readyState !== this.#WS.OPEN) return;
      try {
        // `.ping` isn't on the DOM WebSocket type (browsers hide it), so
        // reach through the duck-typed surface. #configureHeartbeat only
        // enabled the heartbeat after confirming the constructor's
        // prototype has `.ping`, so this is sound at runtime.
        (current as unknown as PingableWebSocket).ping();
      } catch (err) {
        this.#log(`ping send failed: ${describeError(err)}`);
        this.#emitError(err);
        // Treat a ping failure as a dead socket.
        this.#onHeartbeatTimeout();
        return;
      }
      if (this.#pongTimer) clearTimeout(this.#pongTimer);
      this.#pongTimer = setTimeout(() => {
        this.#onHeartbeatTimeout();
      }, this.#heartbeatPongTimeoutMs);
    }, this.#heartbeatIntervalMs);
  }

  /** Clear ping/pong timers and detach the pong listener. */
  #stopHeartbeatTimers(): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (this.#pongTimer) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = null;
    }
    if (this.#pongUnsubscribe) {
      this.#pongUnsubscribe();
      this.#pongUnsubscribe = null;
    }
  }

  /**
   * Register a `pong` listener on a WebSocket. Returns an unsubscribe.
   * Handles both addEventListener (Bun, browsers) and an `onpong` setter,
   * so we don't couple to a single event API. The handler is wrapped so
   * listener errors never crash the interval.
   */
  #addPongListener(ws: AnyWebSocket, handler: () => void): () => void {
    const pws = ws as unknown as PingableWebSocket;
    const wrapped = () => {
      try {
        handler();
      } catch (err) {
        this.#log(`pong handler error: ${describeError(err)}`);
        this.#emitError(err);
      }
    };
    if (typeof pws.addEventListener === "function") {
      const cb = (_ev: Event) => wrapped();
      pws.addEventListener("pong", cb);
      return () => pws.removeEventListener?.("pong", cb);
    }
    if (typeof pws.onpong === "function" || "onpong" in pws) {
      const prev = pws.onpong ?? null;
      pws.onpong = (ev: Event) => { prev?.(ev); wrapped(); };
      return () => { pws.onpong = prev; };
    }
    // No observable pong → heartbeat degrades to ping-only liveness probes.
    return () => {};
  }

  /**
   * No pong within the timeout window → the socket is half-open. Close it
   * with code 1006 (abnormal) so the onclose handler routes into the
   * existing reconnect path. Re-entrancy: called from the interval tick or
   * a failed ping send, both of which hold #ws live.
   */
  #onHeartbeatTimeout(): void {
    if (this.#intentionalClose) return;
    const ws = this.#ws;
    if (!ws) return;
    this.#stopHeartbeatTimers();
    this.#log(`heartbeat: no pong within ${this.#heartbeatPongTimeoutMs}ms — closing`);
    // Force-abort the socket so onclose fires with an abnormal code,
    // triggering the normal reconnect state machine.
    try {
      ws.close(4000, "heartbeat-timeout");
    } catch (err) {
      this.#log(`heartbeat close threw: ${describeError(err)}`);
      this.#emitError(err);
    }
  }

  // ── Status ──────────────────────────────────────────────────────────

  get status(): ConnectionStatus {
    return this.#status;
  }

  onStatusChange(handler: (status: ConnectionStatus) => void): Unsubscribe {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  // ── Event emitter API ───────────────────────────────────────────────

  onFrame(handler: (frame: SyncFrame) => void): Unsubscribe {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }

  onOpen(handler: () => void): Unsubscribe {
    this.#openHandlers.add(handler);
    return () => this.#openHandlers.delete(handler);
  }

  onClose(handler: (info: CloseEventInfo) => void): Unsubscribe {
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }

  onError(handler: (err: unknown) => void): Unsubscribe {
    this.#errorHandlers.add(handler);
    return () => this.#errorHandlers.delete(handler);
  }

  // ── Connection lifecycle ────────────────────────────────────────────

  /**
   * Open the connection. Safe to call multiple times — no-op if already
   * connecting or open. Resolves once the socket is open (or rejects if
   * the ticket fetch fails / the initial connect errors before opening).
   */
  async connect(): Promise<void> {
    const ws = this.#ws;
    if (ws && (ws.readyState === this.#WS.OPEN || ws.readyState === this.#WS.CONNECTING)) {
      return;
    }

    this.#intentionalClose = false;
    this.#setStatus({ state: "connecting" });
    this.#log("Requesting ticket…");

    let ticket: string;
    try {
      ticket = await this.#opts.fetchTicket();
    } catch (err) {
      this.#log(`Ticket fetch failed: ${describeError(err)}`);
      this.#emitError(err);
      // Treat as abnormal close so reconnect logic still runs.
      this.#handleAbnormalClose(0, "ticket-fetch-failed");
      throw err;
    }

    const url = this.#buildUrl(ticket);
    this.#log(`Connecting to ${url.split("?")[0]}…`);

    let socket: AnyWebSocket;
    try {
      socket = new this.#WS(url);
    } catch (err) {
      this.#log(`WebSocket constructor threw: ${describeError(err)}`);
      this.#emitError(err);
      this.#handleAbnormalClose(0, "constructor-threw");
      throw err;
    }
    socket.binaryType = "arraybuffer";
    this.#ws = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.onopen = () => {
        this.#setStatus({ state: "open" });
        this.#log("Connected.");
        // Reset reconnect attempt counter on successful connection.
        this.#reconnectAttempt = 0;
        // Replay topic subscriptions.
        for (const topic of this.#topics.values()) {
          this.#sendSubMessage("sub", topic);
        }
        for (const h of this.#openHandlers) h();
        // Start the heartbeat after subscriptions replay so a missed pong
        // during backfill still triggers a clean reconnect.
        this.#startHeartbeat();
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (typeof data === "string") {
          // Server should only send binary frames in production, but we
          // log strings for diagnostics and don't error out.
          this.#log(`[text frame] ${data}`);
          return;
        }
        if (!(data instanceof ArrayBuffer)) {
          // Some WS impls deliver Buffer/Blob. We only handle ArrayBuffer
          // because binaryType is set to arraybuffer above. Skip otherwise.
          this.#log(`[unexpected binary type: ${(data as object)?.constructor?.name}]`);
          return;
        }
        try {
          const decoded = decodeCborFrame(data);
          for (const h of this.#frameHandlers) h(decoded);
        } catch (err) {
          this.#log(`Frame decode error: ${describeError(err)}`);
          this.#emitError(err);
        }
      };

      socket.onerror = (_event) => {
        // The browser WebSocket spec deliberately hides error details.
        // We forward a generic Error so handlers always get something.
        const err = new Error("WebSocket error");
        this.#log("WebSocket error.");
        this.#emitError(err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      socket.onclose = (event: CloseEvent) => {
        const intentional = this.#intentionalClose;
        this.#ws = null;
        // Heartbeat timers belong to this socket; tear them down before
        // scheduling reconnect so a stray ping doesn't fire on a dead ws.
        this.#stopHeartbeatTimers();
        this.#log(
          `Closed: code=${event.code} reason=${event.reason || "(none)"} intentional=${intentional}`,
        );
        const info: CloseEventInfo = {
          code: event.code,
          reason: event.reason,
          intentional,
        };
        for (const h of this.#closeHandlers) h(info);

        if (intentional) {
          this.#setStatus({
            state: "closed",
            intentional: true,
            code: event.code,
            reason: event.reason,
          });
          if (!settled) {
            settled = true;
            // Intentional close before open settles as resolve — the
            // caller asked us to stop, that's not an error.
            resolve();
          }
        } else {
          if (!settled) {
            settled = true;
            // Abnormal close before open: reject the connect() promise,
            // but still schedule a reconnect for the long-running session.
            reject(new Error(`WebSocket closed before open: code=${event.code}`));
          }
          this.#handleAbnormalClose(event.code, event.reason);
        }
      };
    });
  }

  /**
   * Close the connection and disable auto-reconnect. Safe to call from any
   * state. After calling `close()`, the connection will not reconnect; call
   * `connect()` again to re-establish.
   */
  close(): void {
    this.#intentionalClose = true;
    this.#reconnectAttempt = 0;
    this.#stopHeartbeatTimers();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const ws = this.#ws;
    if (ws) {
      this.#setStatus({ state: "closing" });
      try {
        ws.close();
      } catch (err) {
        this.#log(`Error during close(): ${describeError(err)}`);
        this.#emitError(err);
      }
      // onclose will set final "closed" status.
    } else {
      this.#setStatus({ state: "closed", intentional: true });
    }
  }

  // ── Topic subscription API ──────────────────────────────────────────

  /**
   * Subscribe to a topic. Tracked in-memory so it can be re-sent on
   * reconnect. If currently open, sends the `sub` frame immediately;
   * otherwise the subscription is queued and sent on next `open`.
   */
  subscribe(topic: Topic): void {
    const key = TOPIC_KEY(topic);
    this.#topics.set(key, topic);
    if (this.#ws?.readyState === this.#WS.OPEN) {
      this.#sendSubMessage("sub", topic);
    }
  }

  /**
   * Unsubscribe from a topic. Removes it from the tracked set and, if
   * currently open, sends the `unsub` frame.
   */
  unsubscribe(topic: Topic): void {
    const key = TOPIC_KEY(topic);
    if (!this.#topics.delete(key)) return;
    if (this.#ws?.readyState === this.#WS.OPEN) {
      this.#sendSubMessage("unsub", topic);
    }
  }

  /** Currently-tracked topic set (defensive copy). */
  get subscribedTopics(): Topic[] {
    return [...this.#topics.values()];
  }

  #buildUrl(ticket: string): string {
    const sep = this.#opts.wsUrl.includes("?") ? "&" : "?";
    return `${this.#opts.wsUrl}${sep}ticket=${encodeURIComponent(ticket)}`;
  }

  #sendSubMessage(type: "sub" | "unsub", topic: Topic): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== this.#WS.OPEN) return;
    const payload =
      topic.kind === "stream" && type === "sub" && topic.cursor !== undefined
        ? JSON.stringify({ type, topic: topic.kind, id: topic.id, cursor: topic.cursor })
        : JSON.stringify({ type, topic: topic.kind, id: topic.id });
    try {
      ws.send(payload);
      this.#log(`→ ${type} ${topic.kind}:${shortId(topic.id)}`);
    } catch (err) {
      this.#log(`send(${type}) failed: ${describeError(err)}`);
      this.#emitError(err);
    }
  }

  #handleAbnormalClose(_code: number, _reason: string): void {
    if (this.#intentionalClose) return;
    const attempt = this.#reconnectAttempt;
    this.#reconnectAttempt++;
    const delay = this.#reconnectDelay(attempt);
    if (!Number.isFinite(delay) || delay <= 0) {
      this.#setStatus({ state: "closed", intentional: false });
      return;
    }
    this.#setStatus({ state: "reconnecting", delayMs: delay, attempt: attempt + 1 });
    this.#log(`Reconnect attempt ${attempt + 1} in ${Math.round(delay)}ms…`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      // Swallow errors — reconnect attempts will re-schedule themselves
      // on close, and we've already surfaced them via onError.
      this.connect().catch(() => {});
    }, delay);
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    for (const h of this.#statusHandlers) h(status);
  }

  #emitError(err: unknown): void {
    for (const h of this.#errorHandlers) h(err);
  }

  #log(msg: string): void {
    this.#opts.logger?.(msg);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Decode a binary CBOR frame into its `{ header, body }` pair. Matches the
 * playground's `decodeCborFrame` helper bit-for-bit so wire compat is
 * preserved during the migration.
 */
export function decodeCborFrame(data: ArrayBuffer): SyncFrame {
  const bytes = new Uint8Array(data);
  const [header, remainder] = decodeFirst(bytes);
  const body =
    remainder.byteLength > 0
      ? (decodeFirst(remainder)[0] as Record<string, unknown>)
      : {};
  return {
    header: header as Record<string, unknown>,
    body,
    raw: data,
  };
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
