/**
 * E2E transport-level tests — paths the unit tests (which call router.fetch
 * directly) skip.
 *
 * Tests:
 * - GET /blob/<did>/<cid> → graceful error (no Leaf in disabled mode)
 * - OPTIONS preflight → 204 + CORS headers
 * - GET /health/embed → 200 with stats
 * - Non-existent path → 404
 * - Malformed query params → 400 (schema rejection)
 *
 * Run: bun test --cwd packages/appserver src/e2e/transport.test.ts
 */

import { describe, expect, test } from "bun:test";
import { startAppserver } from "./helpers.ts";

describe("Transport-level edge cases", () => {
  test("GET /blob/<did>/<cid> → graceful error (no Leaf)", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/blob/did%3Aplc%3Atest/some-cid-hash`,
    );
    // In disabled mode, blob proxy can't reach PLC/PDS.
    // Expect a 500 (InternalError) or 502 (BadGateway), not a crash.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
  });

  test("OPTIONS preflight → 204 + CORS headers", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces`,
      { method: "OPTIONS" },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Test-Did",
    );
  });

  test("OPTIONS on health endpoint → 204", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(`${ctx.baseUrl}/health`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
  });

  test("GET /health/embed → 200 with stats", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(`${ctx.baseUrl}/health/embed`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("enrichedOk");
    expect(body).toHaveProperty("enrichedNull");
    expect(body).toHaveProperty("pending");
  });

  test("non-existent path → 404", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.nonexistent.method`,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("MethodNotFound");
  });

  test("non-XRPC path → 404", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(`${ctx.baseUrl}/some/random/path`);
    expect(res.status).toBe(404);
  });

  test("malformed query params → 400 (schema rejection)", async () => {
    const ctx = await startAppserver()
    // getMessages expects roomId as a string; passing an empty string
    // should fail schema validation.
    const res = await ctx.authedFetch("did:plc:test")(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("InvalidRequest");
  });

  test("GET on a procedure endpoint → 405", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("MethodNotAllowed");
  });

  test("POST on a query endpoint → 405", async () => {
    const ctx = await startAppserver()
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getSpaces`,
      { method: "POST", body: "{}" },
    );
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toBe("MethodNotAllowed");
  });
});
