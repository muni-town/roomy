import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { XrpcRouter } from "./router.ts";
import type { AuthCtx } from "./types.ts";

const stubAuth = async (_req: Request): Promise<AuthCtx> => ({
  did: "did:plc:test",
});

function build(register: (r: XrpcRouter) => void): XrpcRouter {
  const r = new XrpcRouter(stubAuth);
  register(r);
  return r;
}

async function call(
  router: XrpcRouter,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const fakeServer = {
    requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 12345 }),
  } as unknown as Parameters<typeof router.fetch>[1];
  const res = await router.fetch(new Request(url, init), fakeServer);
  if (!res) throw new Error("router returned no Response");
  return res;
}

describe("XrpcRouter schema validation", () => {
  describe("query", () => {
    const Params = type({ roomId: "string" });
    const Response = type({ messages: "string[]" });

    test("happy path returns 200 with validated body", async () => {
      const router = build((r) =>
        r.query("test.query", {
          paramsSchema: Params,
          outputSchema: Response,
          handler: async (params) => ({ messages: [`for-${params.roomId}`] }),
        }),
      );
      const res = await call(router, "http://x/xrpc/test.query?roomId=abc");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ messages: ["for-abc"] });
    });

    test("input rejection returns 400 with InvalidRequest", async () => {
      const router = build((r) =>
        r.query("test.query", {
          paramsSchema: Params,
          outputSchema: Response,
          handler: async () => ({ messages: [] }),
        }),
      );
      const res = await call(router, "http://x/xrpc/test.query"); // missing roomId
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("InvalidRequest");
      expect(body.message).toContain("test.query params");
    });

    test("output mismatch throws and surfaces as 500", async () => {
      const router = build((r) =>
        r.query("test.query", {
          paramsSchema: Params,
          outputSchema: Response,
          // Wrong shape on purpose.
          handler: async () => ({ wrong: "shape" }) as never,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.query?roomId=abc");
      expect(res.status).toBe(500);
    });
  });

  describe("procedure", () => {
    const Input = type({ roomId: "string" });
    const Output = type({ ok: "boolean" });

    test("happy path", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          outputSchema: Output,
          handler: async (_p, _a, body: any) => ({
            ok: typeof body.roomId === "string",
          }),
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "r1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    test("input rejection returns 400", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          handler: async () => undefined,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("InvalidRequest");
      expect(body.message).toContain("test.proc input");
    });

    test("output mismatch surfaces as 500", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          outputSchema: Output,
          handler: async () => ({ wrong: 1 }) as never,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "r1" }),
      });
      expect(res.status).toBe(500);
    });

    test("void short-circuit (no outputSchema) returns empty 200", async () => {
      const router = build((r) =>
        r.procedure("test.proc", {
          inputSchema: Input,
          // No outputSchema — handler returns undefined.
          handler: async () => undefined,
        }),
      );
      const res = await call(router, "http://x/xrpc/test.proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "r1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    });
  });

  test("routes without schemas pass through unchanged", async () => {
    const router = build((r) =>
      r.query("legacy", {
        handler: async () => ({ anything: 123 }),
      }),
    );
    const res = await call(router, "http://x/xrpc/legacy?anything=goes");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ anything: 123 });
  });
});
