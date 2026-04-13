import type { Server } from "bun";
import type { AuthCtx, QueryParams, RouteDef } from "./types.ts";
import type { AuthVerifier } from "./auth.ts";
import { consumeTicket } from "./auth.ts";
import { encodeFrame, errorFrame } from "./frame.ts";
import { XrpcError, toErrorResponse } from "./errors.ts";

interface WsData {
  nsid: string;
  params: QueryParams;
  auth: AuthCtx;
  abort: AbortController;
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
          // Subscriptions auth via pre-issued ticket, not the inter-service JWT verifier,
          // because PDS cannot proxy long-lived WebSocket connections.
          const ticket = rawParams["ticket"];
          if (typeof ticket !== "string" || ticket === "") {
            return Response.json(
              { error: "AuthRequired", message: "ticket query parameter required for subscriptions" },
              { status: 401 },
            );
          }
          // consumeTicket throws XrpcError(401) if not found or expired
          const did = consumeTicket(ticket);
          const auth: AuthCtx = { did };

          // Remove ticket from params before handing to handler
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
      } catch (err) {
        return toErrorResponse(err);
      }
    };
  }

  get websocket(): import("bun").WebSocketHandler<WsData> {
    return {
      open: async (ws) => {
        const { nsid, params, auth, abort } = ws.data;
        const route = this.#routes.get(nsid);
        if (!route || route.kind !== "subscription") {
          ws.close(1011, "Internal error");
          return;
        }
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
      },
      close: (ws) => {
        ws.data.abort.abort();
      },
      message: (_ws, _msg) => {},
    };
  }
}
