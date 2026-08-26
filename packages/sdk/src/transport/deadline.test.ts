/**
 * Unit tests for the per-call deadline in `DirectXrpcClient` and the
 * bounded token fetch in `ServiceAuthClient`.
 *
 * The deadline is the anti-hang guarantee: a wedged appserver HTTP request,
 * a stalled response body read, a slow PDS token fetch, or a long 429-retry
 * backoff sleep must all reject with `XrpcTimeoutError` instead of leaving
 * the caller awaiting forever.
 */
import { describe, it, expect, vi } from "vitest";
import { transport } from "../index";

const { DirectXrpcClient, ServiceAuthClient, XrpcTimeoutError } = transport;

// ─── Stubs ────────────────────────────────────────────────────────────────

/** A ServiceAuthClient whose token comes from an injectable async fn. */
function stubAuth(getToken?: () => Promise<string>): ServiceAuthClient {
  return {
    getToken: getToken ?? (async () => "test-token"),
  } as unknown as ServiceAuthClient;
}

/** A fetch that never resolves, so only the deadline can end the call. */
function neverFetch(): typeof fetch {
  return (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

/** A fetch that resolves to a Response whose body read never completes. */
function stalledBodyFetch(): typeof fetch {
  const never = new Promise<Response>(() => {});
  return (async () => {
    return {
      ok: true,
      json: () => never,
      text: () => never,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function stubToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64");
  return `header.${payload}.signature`;
}

/** A minimal agent whose getServiceAuth returns the given promise. */
function stubAgent(getServiceAuth: () => Promise<unknown>): never {
  return {
    com: {
      atproto: {
        server: {
          getServiceAuth,
        },
      },
    },
  } as never;
}

// ─── DirectXrpcClient deadline ────────────────────────────────────────────

describe("DirectXrpcClient request deadline", () => {
  it("rejects with XrpcTimeoutError when the HTTP request never resolves", async () => {
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      stubAuth(),
      { requestTimeoutMs: 50 },
    );
    vi.stubGlobal("fetch", neverFetch());

    const err = await client
      .procedure("space.roomy.space.sendEvents", {
        spaceId: "did:web:space.test",
        events: [],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XrpcTimeoutError);
    expect((err as XrpcTimeoutError).nsid).toBe("space.roomy.space.sendEvents");
    vi.unstubAllGlobals();
  });

  it("rejects with XrpcTimeoutError when the response body read stalls", async () => {
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      stubAuth(),
      { requestTimeoutMs: 50 },
    );
    vi.stubGlobal("fetch", stalledBodyFetch());

    await expect(
      client.query("space.roomy.space.getSpaces", {}),
    ).rejects.toBeInstanceOf(XrpcTimeoutError);
    vi.unstubAllGlobals();
  });

  it("caps 429-retry backoff: the call rejects at the deadline, not after the retry budget", async () => {
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      stubAuth(),
      { requestTimeoutMs: 120 },
    );
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const started = Date.now();
    await expect(
      client.query("space.roomy.space.getSpaces", {}),
    ).rejects.toBeInstanceOf(XrpcTimeoutError);
    // Rejected well before the 60s Retry-After would have allowed.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toBe(1);
    vi.unstubAllGlobals();
  });

  it("lets a fast successful call through", async () => {
    const client = new DirectXrpcClient(
      "http://appserver.test",
      "did:web:appserver.test",
      stubAuth(),
      { requestTimeoutMs: 200 },
    );
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ spaces: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    await expect(
      client.query("space.roomy.space.getSpaces", {}),
    ).resolves.toEqual({
      spaces: [],
    });
    vi.unstubAllGlobals();
  });
});

// ─── ServiceAuthClient bounded token fetch ────────────────────────────────

describe("ServiceAuthClient token fetch deadline", () => {
  it("times out a PDS getServiceAuth that never answers", async () => {
    const agent = stubAgent(() => new Promise<never>(() => {}));
    const auth = new ServiceAuthClient(agent, { timeoutMs: 50 });
    const started = Date.now();

    await expect(
      auth.getToken("did:web:appserver.test"),
    ).rejects.toBeInstanceOf(XrpcTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("returns a cached token without touching the PDS", async () => {
    const token = stubToken({ exp: Math.floor(Date.now() / 1000) + 60 });
    const tokenAgent = stubAgent(async () => ({ data: { token } }));
    const auth = new ServiceAuthClient(tokenAgent, { timeoutMs: 50 });
    await auth.getToken("did:web:appserver.test");

    // Second call with the same client: served from cache, no PDS call.
    await expect(auth.getToken("did:web:appserver.test")).resolves.toBe(token);
  });

  it("retries a 429 from the PDS and succeeds on a later attempt", async () => {
    const token = stubToken({ exp: 1_800_000_000 });
    let calls = 0;
    const agent = stubAgent(async () => {
      calls++;
      if (calls === 1) {
        throw new transport.RateLimitError(1, "rate limited");
      }
      return { data: { token } };
    });
    const auth = new ServiceAuthClient(agent, { timeoutMs: 200 });

    await expect(auth.getToken("did:web:appserver.test")).resolves.toBe(token);
    expect(calls).toBe(2);
  });

  it("throws a non-timeout PDS error through immediately", async () => {
    const agent = stubAgent(async () => {
      throw new Error("401 from PDS");
    });
    const auth = new ServiceAuthClient(agent, { timeoutMs: 200 });

    await expect(auth.getToken("did:web:appserver.test")).rejects.toThrow(
      "401 from PDS",
    );
  });
});
