import type { Server } from "bun";
import type {
  AuthCtx,
  QueryParams,
  RouteDef,
  ClientMessage,
  SyncSocket,
} from "./types.ts";
import type { AuthVerifier } from "./auth.ts";
import { consumeTicket } from "./auth.ts";
import { encodeFrame, errorFrame } from "./frame.ts";
import { XrpcError, toErrorResponse } from "./errors.ts";
import { type } from "arktype";
import {
  checkRateLimit,
  rateLimitResponse,
} from "./rateLimit.ts";

function validateOrReject(
  schema: import("arktype").Type<any>,
  data: unknown,
  nsid: string,
  kind: "params" | "input",
): { ok: true; data: any } | { ok: false; response: Response } {
  const result = schema(data);
  if (result instanceof type.errors) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "InvalidRequest",
          message: `${nsid} ${kind} validation failed: ${result.summary}`,
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: result };
}

function validateOutputOrThrow(
  schema: import("arktype").Type<any>,
  data: unknown,
  nsid: string,
): unknown {
  const result = schema(data);
  if (result instanceof type.errors) {
    throw new Error(
      `${nsid} output validation failed (server bug): ${result.summary}`,
    );
  }
  return result;
}

interface WsData {
  nsid?: string;
  params?: QueryParams;
  auth: AuthCtx;
  abort: AbortController;
  /** Callback set by the sync handler via SyncSocket.onMessage(). */
  onMessage?: (msg: ClientMessage) => void;
  /** Callback set by the sync handler via SyncSocket.onClose(). */
  onClose?: () => void;
}

export class XrpcRouter {
  readonly #routes = new Map<string, RouteDef>();
  readonly #auth: AuthVerifier;

  constructor(auth: AuthVerifier) {
    this.#auth = auth;
  }

  query(nsid: string, def: Omit<import("./types.ts").QueryDef, "kind">): this {
    this.#routes.set(nsid, { kind: "query", ...def });
    return this;
  }

  procedure(
    nsid: string,
    def: Omit<import("./types.ts").ProcedureDef, "kind">,
  ): this {
    this.#routes.set(nsid, { kind: "procedure", ...def });
    return this;
  }

  subscription(
    nsid: string,
    def: Omit<import("./types.ts").SubscriptionDef, "kind">,
  ): this {
    this.#routes.set(nsid, { kind: "subscription", ...def });
    return this;
  }

  sync(nsid: string, def: Omit<import("./types.ts").SyncDef, "kind">): this {
    this.#routes.set(nsid, { kind: "sync", ...def });
    return this;
  }

  get fetch(): (
    req: Request,
    server: Server<WsData>,
  ) => Promise<Response | undefined> {
    return async (req, server) => {
      const url = new URL(req.url);

      // ── Rate limit check (before auth, IP-based) ───────────────────
      const directIp = server.requestIP(req)?.address ?? "unknown";
      const rl = await checkRateLimit(req, directIp);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

      const match = url.pathname.match(/^\/xrpc\/(.+)$/);
      if (!match?.[1]) return new Response("Not found", { status: 404 });
      const nsid = match[1];

      const route = this.#routes.get(nsid);
      if (!route) {
        return Response.json(
          { error: "MethodNotFound", message: `Unknown NSID: ${nsid}` },
          { status: 404 },
        );
      }

      const rawParams: QueryParams = {};
      for (const [k, v] of url.searchParams.entries()) {
        const existing = rawParams[k];
        if (existing !== undefined) {
          rawParams[k] = Array.isArray(existing)
            ? [...existing, v]
            : [existing, v];
        } else {
          rawParams[k] = v;
        }
      }

      try {
        if (route.kind === "query") {
          if (req.method !== "GET") {
            return Response.json(
              { error: "MethodNotAllowed", message: "Queries require GET" },
              { status: 405 },
            );
          }
          const auth = await this.#auth(req);
          let params: QueryParams | unknown = route.parseParams
            ? route.parseParams(rawParams)
            : rawParams;
          if (route.paramsSchema) {
            const v = validateOrReject(
              route.paramsSchema,
              params,
              nsid,
              "params",
            );
            if (!v.ok) return v.response;
            params = v.data;
          }
          const result = await route.handler(params as QueryParams, auth);
          const validated = route.outputSchema
            ? validateOutputOrThrow(route.outputSchema, result, nsid)
            : result;
          return Response.json(validated);
        }

        if (route.kind === "procedure") {
          if (req.method !== "POST") {
            return Response.json(
              { error: "MethodNotAllowed", message: "Procedures require POST" },
              { status: 405 },
            );
          }
          const auth = await this.#auth(req);
          const params = route.parseParams
            ? route.parseParams(rawParams)
            : rawParams;
          let body: Record<string, unknown> = {};
          const contentType = req.headers.get("content-type");
          if (contentType?.includes("application/json")) {
            try {
              body = (await req.json()) as Record<string, unknown>;
            } catch {
              return Response.json(
                { error: "InvalidRequest", message: "Malformed JSON body" },
                { status: 400 },
              );
            }
          }
          let validatedBody: unknown = body;
          if (route.inputSchema) {
            const v = validateOrReject(route.inputSchema, body, nsid, "input");
            if (!v.ok) return v.response;
            validatedBody = v.data;
          }
          const result = await route.handler(
            params,
            auth,
            validatedBody as Record<string, unknown>,
          );
          if (route.outputSchema) {
            const validated = validateOutputOrThrow(
              route.outputSchema,
              result,
              nsid,
            );
            return Response.json(validated);
          }
          // Void short-circuit (b57ad1ca): no outputSchema means void return.
          return result !== undefined
            ? Response.json(result)
            : new Response(null, { status: 200 });
        }

        if (route.kind === "subscription") {
          const ticket = rawParams["ticket"];
          if (typeof ticket !== "string" || ticket === "") {
            return Response.json(
              {
                error: "AuthRequired",
                message: "ticket query parameter required for subscriptions",
              },
              { status: 401 },
            );
          }
          const did = consumeTicket(ticket);
          const auth: AuthCtx = { did };

          const { ticket: _removed, ...paramsWithoutTicket } = rawParams;
          const params = route.parseParams
            ? route.parseParams(paramsWithoutTicket)
            : paramsWithoutTicket;

          const abort = new AbortController();
          const upgraded = server.upgrade(req, {
            data: { nsid, params, auth, abort } satisfies WsData,
          });
          if (!upgraded) {
            return new Response("Expected WebSocket upgrade", { status: 426 });
          }
          return undefined;
        }

        if (route.kind === "sync") {
          const ticket = rawParams["ticket"];
          if (typeof ticket !== "string" || ticket === "") {
            return Response.json(
              {
                error: "AuthRequired",
                message: "ticket query parameter required for subscriptions",
              },
              { status: 401 },
            );
          }
          const did = consumeTicket(ticket);
          const auth: AuthCtx = { did };

          const abort = new AbortController();
          const upgraded = server.upgrade(req, {
            data: { nsid, auth, abort } satisfies WsData,
          });
          if (!upgraded) {
            return new Response("Expected WebSocket upgrade", { status: 426 });
          }
          return undefined;
        }
      } catch (err) {
        return toErrorResponse(err);
      }
    };
  }

  get websocket(): import("bun").WebSocketHandler<WsData> {
    return {
      open: (ws) => {
        const { auth, abort } = ws.data;
        const routeNsid = ws.data.nsid;

        const route = routeNsid ? this.#routes.get(routeNsid) : undefined;
        if (!route) {
          ws.close(1011, "Internal error: unknown NSID");
          return;
        }

        // Legacy subscription (AsyncIterable)
        if (route.kind === "subscription") {
          const rawParams = ws.data.params ?? {};
          const parsedParams = route.parseParams
            ? route.parseParams(rawParams)
            : rawParams;
          this.#runSubscription(ws, parsedParams, auth, abort, route);
          return;
        }

        // Sync (multiplexed bidirectional)
        if (route.kind === "sync") {
          const socket: SyncSocket = {
            send: (frame) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodeFrame(frame));
              }
            },
            onMessage: (handler) => {
              ws.data.onMessage = handler;
            },
            onClose: (handler) => {
              ws.data.onClose = handler;
            },
            get isOpen() {
              return ws.readyState === WebSocket.OPEN;
            },
            get did() {
              if (auth.did === null) {
                throw new Error(
                  "WebSocket did must be set — server bug: unauthenticated sync connection",
                );
              }
              return auth.did;
            },
          };

          route.handler(socket);
          return;
        }

        ws.close(1011, "Internal error: unexpected route kind");
      },

      message: (ws, msg) => {
        // Sync handler: JSON text frames from client (sub/unsub/cursor).
        if (typeof msg === "string") {
          try {
            const parsed = JSON.parse(msg) as ClientMessage;
            ws.data.onMessage?.(parsed);
          } catch {
            // Malformed client message — ignore.
          }
        }
      },

      close: (ws) => {
        ws.data.abort.abort();
        ws.data.onClose?.();
      },
    };
  }

  /** Run a legacy subscription handler (AsyncIterable). */
  async #runSubscription(
    ws: import("bun").ServerWebSocket<WsData>,
    params: QueryParams,
    auth: AuthCtx,
    abort: AbortController,
    route: import("./types.ts").SubscriptionDef,
  ): Promise<void> {
    try {
      const iterable = route.handler(params, auth, abort.signal);
      for await (const frame of iterable) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const result = ws.send(encodeFrame(frame));
        if (result === -1) break; // send buffer full
      }
      ws.close(1000, "Stream ended");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Stream error";
      const errType =
        err instanceof XrpcError ? err.xrpcError : "InternalServerError";
      ws.send(encodeFrame(errorFrame(errType, msg)));
      ws.close(1011, msg);
    }
  }
}
