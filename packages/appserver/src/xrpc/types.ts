import type { Type } from "arktype";

export interface AuthCtx {
  did: string | null;
}

export interface Frame {
  header: FrameHeader;
  body: Record<string, unknown>;
}

export interface FrameHeader {
  op: 1 | -1;
  t: string;
}

export type QueryParams = Record<string, string | string[] | undefined>;

export type QueryHandler<
  TParams extends QueryParams = QueryParams,
  TResult = unknown,
> = (params: TParams, auth: AuthCtx) => Promise<TResult>;

export type SubscriptionHandler<TParams extends QueryParams = QueryParams> = (
  params: TParams,
  auth: AuthCtx,
  signal: AbortSignal,
) => AsyncIterable<Frame>;

export interface QueryDef {
  kind: "query";
  handler: QueryHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
  /** Arktype schema for incoming query-string params. Rejects on parse failure. */
  paramsSchema?: Type<any, any>;
  /** Arktype schema for outgoing JSON response. Throws (500) on parse failure. */
  outputSchema?: Type<any, any>;
}

export type ProcedureHandler<
  TBody = Record<string, unknown>,
  TResult = unknown,
> = (params: QueryParams, auth: AuthCtx, body: TBody) => Promise<TResult>;

export interface ProcedureDef {
  kind: "procedure";
  handler: ProcedureHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
  /** Arktype schema for incoming JSON body. Rejects on parse failure. */
  inputSchema?: Type<any, any>;
  /** Arktype schema for outgoing JSON response. Throws (500) on parse failure.
   * If omitted, the handler is expected to return void/undefined and the
   * response short-circuits to 200 with no body (b57ad1ca behaviour). */
  outputSchema?: Type<any, any>;
}

export interface SubscriptionDef {
  kind: "subscription";
  handler: SubscriptionHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

// ─── Sync (multiplexed WebSocket) ──────────────────────────────────────

/** Client → Server message types (JSON text frames). */
export type ClientMessage =
  | { type: "sub"; topic: "space" | "room" | "mentions"; id: string }
  | { type: "unsub"; topic: "space" | "room" | "mentions"; id: string }
  | { type: "sub"; topic: "stream"; id: string; cursor: number }
  | { type: "unsub"; topic: "stream"; id: string }
  | { type: "cursor"; seq: number }
  | {
      type: "voice_state";
      roomId: string;
      muted: boolean;
      deafened: boolean;
    };

/**
 * Abstraction over a single WS connection, passed to the SyncHandler.
 * Never touches the raw Bun WebSocket directly.
 */
export interface SyncSocket {
  /** Send a CBOR frame to the client. */
  send(frame: Frame): void;
  /** Register handler for incoming client messages (sub/unsub/cursor). */
  onMessage(handler: (msg: ClientMessage) => void): void;
  /** Register handler for when the connection closes. */
  onClose(handler: () => void): void;
  /** Check if connection is still open. */
  readonly isOpen: boolean;
  /** Authenticated DID of the connected user. */
  readonly did: string;
}

export interface SyncDef {
  kind: "sync";
  handler: SyncHandler;
}

/** Called once when a sync WS connection opens. Manages topic subscriptions. */
export type SyncHandler = (socket: SyncSocket) => void;

// ─── Stream (long-lived HTTP response) ─────────────────────────────────

/** What the router hands a stream handler besides the raw request. */
export interface StreamContext {
  /** Parsed query-string params, same shape queries receive. */
  params: QueryParams;
  /**
   * Verify the request's bearer token with the router's verifier, exactly as
   * queries and procedures are verified. Lazy so a handler can refuse cheaply
   * (wrong replica, at capacity) before paying for identity resolution.
   */
  authenticate: () => Promise<AuthCtx>;
}

/**
 * Handler for a long-lived HTTP response such as `text/event-stream`. It gets
 * the raw `Request` and returns the `Response` itself, because the router's
 * JSON round-trip (validate output, `Response.json`) cannot carry a stream.
 *
 * The token is only checked when `authenticate()` is called, and only once:
 * the stream outlives the token, so nothing about the response may depend on
 * the token staying valid.
 */
export type StreamHandler = (
  req: Request,
  context: StreamContext,
) => Promise<Response>;

export interface StreamDef {
  kind: "stream";
  handler: StreamHandler;
}

export type RouteDef =
  | QueryDef
  | ProcedureDef
  | SubscriptionDef
  | SyncDef
  | StreamDef;
