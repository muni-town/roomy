/**
 * Tests for the session-request counter.
 *
 * The contract: a run of rejected requests to the session origin escalates to
 * the recovery path exactly once, and only after the run is long enough to mean
 * a dead session rather than a blip. Everything the recovery path does with the
 * failure (reload, then the login hand-off) is `error-recovery.ts`'s and is
 * covered there; what is pinned here is that the failure is *noticed* at all,
 * and that the count is consecutive.
 *
 * Written against `node:test` + `node:assert` (app-lite ships no test runner of
 * its own) so the file runs under both `bun test` and
 * `node --test --experimental-strip-types`.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_FAILURE_LIMIT,
  STREAK_TTL_MS,
  createSessionAwareFetch,
  resetSessionStreak,
  sessionFailureError,
  type SessionFailure,
  type SessionStore,
} from "./session-health.ts";
import { isRecoverableAtprotoError } from "./error-recovery.ts";

const ORIGIN = "https://hv.example.test";
const OTHER_ORIGIN = "https://api.example.test";

/** How the fake session origin answers the next request. */
type Reply =
  | { status: number }
  | { reject: "network" }
  | { reject: "abort" };

interface Harness {
  wrapped: typeof globalThis.fetch;
  escalations: SessionFailure[];
  streaks: number[];
  calls: string[];
  answer(next: Reply): void;
}

/** A `sessionStorage` stand-in, so a run can be carried between documents. */
function memoryStorage(): SessionStore & {
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function harness(
  limit = SESSION_FAILURE_LIMIT,
  storage: SessionStore | null = null,
): Harness {
  const escalations: SessionFailure[] = [];
  const streaks: number[] = [];
  const calls: string[] = [];
  let reply: Reply = { status: 401 };

  const fetch: typeof globalThis.fetch = async (input) => {
    calls.push(String(input));
    if ("reject" in reply) {
      const err = new Error(reply.reject === "abort" ? "aborted" : "Failed to fetch");
      if (reply.reject === "abort") err.name = "AbortError";
      else err.name = "TypeError";
      throw err;
    }
    return new Response("{}", { status: reply.status });
  };

  const wrapped = createSessionAwareFetch({
    origin: ORIGIN,
    fetch,
    limit,
    storage,
    onExhausted: (failure) => escalations.push(failure),
    onStreak: (streak) => streaks.push(streak),
  });

  return {
    wrapped,
    escalations,
    streaks,
    calls,
    answer(next: Reply) {
      reply = next;
    },
  };
}

/** Drive one request to the session origin. */
async function request(h: Harness, path = "/xrpc/query"): Promise<void> {
  await h.wrapped(`${ORIGIN}${path}`);
}

describe("createSessionAwareFetch", () => {
  test("escalates exactly once when a run crosses the limit", async () => {
    const h = harness();

    for (let i = 0; i < SESSION_FAILURE_LIMIT; i += 1) {
      const response = await h.wrapped(`${ORIGIN}/xrpc/query`);
      assert.equal(response.status, 401);
      assert.equal(h.escalations.length, i === SESSION_FAILURE_LIMIT - 1 ? 1 : 0);
    }

    // Further rejections in the same run do not escalate again: the recovery
    // path is already deciding, and re-reporting would only spend its budget.
    for (let i = 0; i < 5; i += 1) await request(h);

    assert.equal(h.escalations.length, 1);
    assert.equal(h.escalations[0]?.count, SESSION_FAILURE_LIMIT);
    assert.equal(h.escalations[0]?.status, 401);
    assert.equal(h.escalations[0]?.origin, ORIGIN);
    assert.equal(h.escalations[0]?.url, `${ORIGIN}/xrpc/query`);
    assert.equal(h.streaks.length, SESSION_FAILURE_LIMIT + 5);
  });

  test("the first rejection does not escalate", async () => {
    const h = harness();
    await request(h);
    assert.equal(h.escalations.length, 0);
    assert.deepEqual(h.streaks, [1]);
  });

  test("a success resets the run", async () => {
    const h = harness();
    for (let i = 0; i < SESSION_FAILURE_LIMIT - 1; i += 1) await request(h);

    h.answer({ status: 200 });
    await request(h);

    // The same run, continued after a success, is a new run: it must reach the
    // limit again from zero before it escalates.
    h.answer({ status: 401 });
    for (let i = 0; i < SESSION_FAILURE_LIMIT - 1; i += 1) await request(h);
    assert.equal(h.escalations.length, 0);
    assert.deepEqual(h.streaks, [
      ...Array.from({ length: SESSION_FAILURE_LIMIT - 1 }, (_, i) => i + 1),
      0,
      ...Array.from({ length: SESSION_FAILURE_LIMIT - 1 }, (_, i) => i + 1),
    ]);

    await request(h);
    assert.equal(h.escalations.length, 1);
  });

  test("the count is consecutive, not cumulative", async () => {
    const h = harness(3);
    await request(h);
    await request(h);
    h.answer({ status: 200 });
    await request(h);
    assert.deepEqual(h.streaks, [1, 2, 0]);

    h.answer({ status: 401 });
    await request(h);
    await request(h);
    await request(h);
    assert.equal(h.escalations.length, 1);
    assert.deepEqual(h.streaks, [1, 2, 0, 1, 2, 3]);
  });

  test("a request that never got a response counts, and is still rethrown", async () => {
    const h = harness(2);
    h.answer({ reject: "network" });

    await assert.rejects(request(h));
    await assert.rejects(request(h));

    assert.equal(h.escalations.length, 1);
    assert.equal(h.escalations[0]?.status, 0);
  });

  test("a cancelled request is not a failure", async () => {
    const h = harness(2);
    h.answer({ reject: "abort" });

    await assert.rejects(request(h), { name: "AbortError" });
    await assert.rejects(request(h), { name: "AbortError" });

    assert.equal(h.escalations.length, 0);
    assert.deepEqual(h.streaks, []);
  });

  test("requests to another origin are forwarded untouched", async () => {
    const h = harness(2);

    await h.wrapped(`${OTHER_ORIGIN}/xrpc/query`);
    await h.wrapped(`${OTHER_ORIGIN}/xrpc/query`);
    await h.wrapped(`${OTHER_ORIGIN}/xrpc/query`);

    assert.equal(h.escalations.length, 0);
    assert.deepEqual(h.streaks, []);
    assert.equal(h.calls.length, 3);
  });

  test("a non-401 response ends the run", async () => {
    const h = harness(3);
    await request(h);
    await request(h);
    h.answer({ status: 500 });
    await request(h);
    assert.deepEqual(h.streaks, [1, 2, 0]);
    assert.equal(h.escalations.length, 0);
  });

  test("a run is carried into the document its escalation reloaded into", async () => {
    const storage = memoryStorage();

    const first = harness(SESSION_FAILURE_LIMIT, storage);
    for (let i = 0; i < SESSION_FAILURE_LIMIT; i += 1) await request(first);
    assert.equal(first.escalations.length, 1);

    // The reload's document: the run it inherited crosses the limit again on
    // its first rejection, which is what lets the auto-reload budget spend
    // itself instead of reloading once every three minutes forever.
    const second = harness(SESSION_FAILURE_LIMIT, storage);
    await request(second);
    assert.equal(second.escalations.length, 1);
    assert.equal(second.escalations[0]?.count, SESSION_FAILURE_LIMIT + 1);
  });

  test("a success clears the carried run", async () => {
    const storage = memoryStorage();

    const first = harness(SESSION_FAILURE_LIMIT, storage);
    for (let i = 0; i < SESSION_FAILURE_LIMIT; i += 1) await request(first);
    assert.equal(first.escalations.length, 1);

    // The reload found a live session: its own restore request succeeded.
    const second = harness(SESSION_FAILURE_LIMIT, storage);
    second.answer({ status: 200 });
    await request(second);
    assert.deepEqual(second.streaks, [0]);

    // A later, unrelated rejection is the first of a new run again.
    const third = harness(SESSION_FAILURE_LIMIT, storage);
    await request(third);
    assert.equal(third.escalations.length, 0);
    assert.deepEqual(third.streaks, [1]);
  });

  test("a run that went quiet past the ttl starts over", async () => {
    const storage = memoryStorage();
    storage.setItem(
      `roomy:sessionStreak:${ORIGIN}`,
      JSON.stringify({
        count: SESSION_FAILURE_LIMIT,
        at: Date.now() - STREAK_TTL_MS - 1,
      }),
    );

    const h = harness(SESSION_FAILURE_LIMIT, storage);
    await request(h);
    assert.equal(h.escalations.length, 0);
    assert.deepEqual(h.streaks, [1]);
  });

  test("signing out forgets the run", async () => {
    const storage = memoryStorage();

    const first = harness(SESSION_FAILURE_LIMIT, storage);
    for (let i = 0; i < SESSION_FAILURE_LIMIT; i += 1) await request(first);
    assert.equal(first.escalations.length, 1);

    resetSessionStreak(ORIGIN, storage);

    // A new session: its first rejection is the first of a new run, not the
    // thirteenth of the dead one.
    const second = harness(SESSION_FAILURE_LIMIT, storage);
    await request(second);
    assert.equal(second.escalations.length, 0);
    assert.deepEqual(second.streaks, [1]);
  });

  test("the escalation is an error the recovery path recognises", () => {
    const failure: SessionFailure = {
      origin: ORIGIN,
      count: SESSION_FAILURE_LIMIT,
      status: 401,
      url: `${ORIGIN}/xrpc/query`,
    };
    assert.equal(isRecoverableAtprotoError(sessionFailureError(failure)), true);
  });
});
