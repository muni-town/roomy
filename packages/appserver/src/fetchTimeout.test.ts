/**
 * The profile fetches must be bounded.
 *
 * `fetch` has no timeout of its own, and on these paths the thing awaiting it
 * is a user request: a HappyView (or PDS, or appview) that accepts the
 * connection and then says nothing would otherwise hold that request open
 * forever.
 * These tests pin the bound against a real server that never responds, rather
 * than against a mocked `fetch` — the behaviour under test is what `fetch`
 * does with an aborted signal, which a mock would replace.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithTimeout, profileFetchTimeoutMs } from "./fetchTimeout.ts";

/** A server that accepts the request and never answers. */
function startBlackHole(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** A server that sends headers, then stalls mid-body forever. */
function startBodyStall(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"profiles":['));
            // never closes
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

const original = process.env.PROFILE_FETCH_TIMEOUT_MS;
afterEach(() => {
  if (original === undefined) delete process.env.PROFILE_FETCH_TIMEOUT_MS;
  else process.env.PROFILE_FETCH_TIMEOUT_MS = original;
});

describe("profile fetch timeout", () => {
  test("aborts a server that never responds", async () => {
    const server = startBlackHole();
    process.env.PROFILE_FETCH_TIMEOUT_MS = "120";
    try {
      expect(profileFetchTimeoutMs()).toBe(120);
      const started = Date.now();
      const err = await fetchWithTimeout(server.url).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      // It rejected because of the deadline, not because the request failed
      // on its own (a black hole never fails).
      expect((err as Error).name).toBe("TimeoutError");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      server.stop();
    }
  });

  test("the deadline also covers a stalled body read", async () => {
    // Headers arriving is not the request completing: an unbounded body read
    // would still hang the caller, so the abort must reject `res.json()` too.
    const server = startBodyStall();
    process.env.PROFILE_FETCH_TIMEOUT_MS = "120";
    try {
      const err = await fetchWithTimeout(server.url)
        .then((res) => res.json())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("TimeoutError");
    } finally {
      server.stop();
    }
  });

  test("a caller-supplied signal still aborts, whichever comes first", async () => {
    const server = startBlackHole();
    process.env.PROFILE_FETCH_TIMEOUT_MS = "10000";
    try {
      const caller = AbortSignal.timeout(120);
      const err = await fetchWithTimeout(server.url, { signal: caller }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("TimeoutError");
    } finally {
      server.stop();
    }
  });

  test("a responsive server is unaffected", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ profiles: [{ did: "did:plc:x" }] }),
    });
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${server.port}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ profiles: [{ did: "did:plc:x" }] });
    } finally {
      server.stop(true);
    }
  });
});
