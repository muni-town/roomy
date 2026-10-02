/**
 * The query-param boundary: an XRPC query param must be a scalar.
 *
 * Regression for the observed appserver log line `Room not found:
 * [object Object]` — a non-scalar reaching an id-shaped param and stringifying
 * into a plausible-looking request. The assertions are behavioral: no HTTP
 * request is issued and no service-auth token is fetched, so the bad call
 * cannot reach the appserver at all (and so cannot be mistaken for a missing
 * entity once it is there).
 */
import { describe, it, expect, vi } from "vitest";
import { transport } from "../../src/index";

const { DirectXrpcClient, ServiceAuthClient } = transport;

/** Record the request URLs a call attempts, so "no request" is assertable. */
function recordRequests(): { urls: string[]; fetch: typeof fetch } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (async (input: unknown) => {
      urls.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "{}",
      } as unknown as Response;
    }) as unknown as typeof fetch,
  };
}

describe("XRPC query param boundary", () => {
  it("rejects a nested object instead of sending [object Object]", async () => {
    const { urls, fetch } = recordRequests();
    vi.stubGlobal("fetch", fetch);
    let tokenFetched = false;
    const auth = {
      getToken: async () => {
        tokenFetched = true;
        return "test-token";
      },
    } as unknown as ServiceAuthClient;
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      auth,
    );

    const err = await client
      .query("space.roomy.room.getMetadata", {
        roomId: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toContain("[object Object]");
    expect(urls).toEqual([]);
    // The guard runs before the token fetch, so a bad call costs no PDS trip.
    expect(tokenFetched).toBe(false);
    vi.unstubAllGlobals();
  });

  it("rejects an array, which would otherwise look like a real id", async () => {
    const { urls, fetch } = recordRequests();
    vi.stubGlobal("fetch", fetch);
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      { getToken: async () => "test-token" } as unknown as ServiceAuthClient,
    );

    // `String(["01ARZ3NDEKTSV4RRFFQ69G5FAV"])` is the id itself — the most
    // deceptive shape of the same bug.
    const err = await client
      .query("space.roomy.room.getMetadata", {
        roomId: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      } as never)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toContain("an array");
    expect(urls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("rejects a non-scalar on the untyped `.call()` path too", async () => {
    const { urls, fetch } = recordRequests();
    vi.stubGlobal("fetch", fetch);
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      { getToken: async () => "test-token" } as unknown as ServiceAuthClient,
    );

    const err = await client
      .call("space.roomy.space.getMetadata", { spaceId: { did: "x" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(urls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("still sends scalars, and omits undefined/null", async () => {
    const { urls, fetch } = recordRequests();
    vi.stubGlobal("fetch", fetch);
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      { getToken: async () => "test-token" } as unknown as ServiceAuthClient,
    );

    await client.call("space.roomy.room.getMetadata", {
      roomId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      includeDeleted: "true",
    });

    const url = new URL(urls[0]!);
    expect(url.searchParams.get("roomId")).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(url.searchParams.get("includeDeleted")).toBe("true");
    expect(url.searchParams.has("cursor")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("omits undefined and null params rather than stringifying them", async () => {
    const { urls, fetch } = recordRequests();
    vi.stubGlobal("fetch", fetch);
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      { getToken: async () => "test-token" } as unknown as ServiceAuthClient,
    );

    await client.call("space.roomy.space.getThreads", {
      spaceId: "did:plc:abcdefghijklmnopqrstuvwx",
      limit: undefined,
      cursor: null,
    } as never);

    const url = new URL(urls[0]!);
    expect(url.searchParams.get("spaceId")).toBe(
      "did:plc:abcdefghijklmnopqrstuvwx",
    );
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("cursor")).toBe(false);
    vi.unstubAllGlobals();
  });
});
