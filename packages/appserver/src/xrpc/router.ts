import type { Server } from "bun";
import type { AuthCtx, QueryParams, RouteDef, ClientMessage, SyncSocket } from "./types.ts";
import type { AuthVerifier } from "./auth.ts";
import { consumeTicket } from "./auth.ts";
import { encodeFrame, errorFrame } from "./frame.ts";
import { XrpcError, toErrorResponse } from "./errors.ts";

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

  procedure(nsid: string, def: Omit<import("./types.ts").ProcedureDef, "kind">): this {
    this.#routes.set(nsid, { kind: "procedure", ...def });
    return this;
  }

  subscription(nsid: string, def: Omit<import("./types.ts").SubscriptionDef, "kind">): this {
    this.#routes.set(nsid, { kind: "subscription", ...def });
    return this;
  }

  sync(nsid: string, def: Omit<import("./types.ts").SyncDef, "kind">): this {
    this.#routes.set(nsid, { kind: "sync", ...def });
    return this;
  }

  get fetch(): (req: Request, server: Server<WsData>) => Promise<Response | undefined> {
    return async (req, server) => {
      const url = new URL(req.url);
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
          rawParams[k] = Array.isArray(existing) ? [...existing, v] : [existing, v];
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
          const params = route.parseParams ? route.parseParams(rawParams) : rawParams;
          const result = await route.handler(params, auth);
          return Response.json(result);
        }

        if (route.kind === "procedure") {
          if (req.method !== "POST") {
            return Response.json(
              { error: "MethodNotAllowed", message: "Procedures require POST" },
              { status: 405 },
            );
          }
          const auth = await this.#auth(req);
          const params = route.parseParams ? route.parseParams(rawParams) : rawParams;
          const result = await route.handler(params, auth);
          return Response.json(result);
        }

        if (route.kind === "subscription") {
          const ticket = rawParams["ticket"];
          if (typeof ticket !== "string" || ticket === "") {
            return Response.json(
              { error: "AuthRequired", message: "ticket query parameter required for subscriptions" },
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
              { error: "AuthRequired", message: "ticket query parameter required for subscriptions" },
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
          const parsedParams = route.parseParams ? route.parseParams(rawParams) : rawParams;
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
      const errType = err instanceof XrpcError ? err.xrpcError : "InternalServerError";
      ws.send(encodeFrame(errorFrame(errType, msg)));
      ws.close(1011, msg);
    }
  }
}
