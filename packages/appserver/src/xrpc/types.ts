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

// HTTP POST — no request body parsing; params come from URL query string only
export interface ProcedureDef {
  kind: "procedure";
  handler: QueryHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

export interface SubscriptionDef {
  kind: "subscription";
  handler: SubscriptionHandler;
  parseParams?: (raw: QueryParams) => QueryParams;
}

export type RouteDef = QueryDef | ProcedureDef | SubscriptionDef;
