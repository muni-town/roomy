export interface AuthCtx {
  did: string;
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

export type SubscriptionHandler<
  TParams extends QueryParams = QueryParams,
> = (params: TParams, auth: AuthCtx, signal: AbortSignal) => AsyncIterable<Frame>;

export interface QueryDef {
  kind: "query";
  handler: QueryHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

export type ProcedureHandler<
  TBody = Record<string, unknown>,
  TResult = unknown,
> = (params: QueryParams, auth: AuthCtx, body: TBody) => Promise<TResult>;

export interface ProcedureDef {
  kind: "procedure";
  handler: ProcedureHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

export interface SubscriptionDef {
  kind: "subscription";
  handler: SubscriptionHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

// ─── Sync (multiplexed WebSocket) ──────────────────────────────────────

/** Client → Server message types (JSON text frames). */
export type ClientMessage =
  | { type: "sub"; topic: "space" | "room"; id: string }
  | { type: "unsub"; topic: "space" | "room"; id: string }
  | { type: "cursor"; seq: number };

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

export type RouteDef = QueryDef | ProcedureDef | SubscriptionDef | SyncDef;
