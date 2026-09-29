/**
 * Unit tests for `DirectXrpcClient` unauthenticated mode.
 *
 * `DirectXrpcClient` may be constructed without a `ServiceAuthClient` (the
 * `serviceAuth` argument is optional). In that mode it must:
 *
 *   - NOT call `serviceAuth.getToken(...)` — there is no serviceAuth.
 *   - OMIT the `Authorization: Bearer …` header entirely.
 *   - Still validate the response against the registered registry schema
 *     (so the caller gets the same typed, validated result as an authed call).
 *
 * This powers `space.roomy.auth.getLoginScope`, which the app must be able to
 * call *before* the user has a token — the chicken-and-egg that unauthenticated
 * XRPC exists to break.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transport } from "../index";

const { DirectXrpcClient } = transport;

describe("DirectXrpcClient unauthenticated mode", () => {
  // A registry-typed query that is legitimately anonymous: returns `{ did, scope }`.
  const NSID = "space.roomy.auth.getLoginScope";
  let lastInit: RequestInit | undefined;
  let lastUrl: string | undefined;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        lastInit = init;
        lastUrl = String(input);
        return new Response(
          JSON.stringify({ did: "did:plc:example", scope: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    lastInit = undefined;
    lastUrl = undefined;
  });

  it("omits the Authorization header when no serviceAuth is provided", async () => {
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
    );

    const res = await client.query(NSID, { handle: "alice.bsky.social" });

    // No Authorization header sent.
    expect(lastInit?.headers).toBeDefined();
    const headers = new Headers(lastInit!.headers);
    expect(headers.has("authorization")).toBe(false);
    // The GET went to the right endpoint with the handle param.
    expect(lastUrl).toContain(`/xrpc/${NSID}`);
    expect(lastUrl).toContain("handle=alice.bsky.social");
    // Response still validates against the registry schema.
    expect(res).toEqual({ did: "did:plc:example", scope: null });
  });

  it("validates the response against the registry schema even unauthenticated", async () => {
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
    );

    // `scope` is optional in the schema; a bare `{ did }` must still parse.
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ did: "did:plc:example" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    );

    const res = await client.query(NSID, { handle: "alice.bsky.social" });
    expect(res).toEqual({ did: "did:plc:example" });
  });

  it("throws a typed XRPC error for a non-OK response without auth", async () => {
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
    );
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ error: "NotFound" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    );

    const err = await client
      .query(NSID, { handle: "missing.example" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { status?: number }).status).toBe(404);
  });
});
