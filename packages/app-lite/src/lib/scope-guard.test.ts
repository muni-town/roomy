/**
 * Unit tests for `scope-guard.ts` — the reactive consent-flow decisions that
 * `auth.svelte.ts` / the dialogue wiring apply (kept out of the `svelte.ts`
 * and `.svelte` modules so they run under app-lite's
 * `node --test --experimental-strip-types` runner).
 *
 * Pins two contracts:
 *
 *   - `isInsufficientScopeError` — the narrow predicate that matches *only* the
 *     resource-server scope-miss this PDS surfaces
 *     (`error === "ScopeMissingError"`, `status === 403`). It must NOT match a
 *     request-time `invalid_scope`, a server 500, a plain Error, a 403 with an
 *     unrelated name, or the message-only shape without a 403 — a predicate
 *     that matches everything is precisely the failure Phase 5 exists to
 *     prevent.
 *   - `guardedXrpc` — runs the call, and only on a recognised scope-miss with a
 *     `requiredTier` + prompt invokes the prompt; never retries, so even a
 *     no-op `requestScopeExpansion` (app-password/test mode) cannot loop.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isInsufficientScopeError,
  SCOPE_MISSING_ERROR_NAME,
  guardedXrpc,
  type ScopeExpansionPrompt,
} from "./scope-guard.ts";
import type { ScopeSetName } from "./scopes.ts";

/** The measured/source-verified wire shape: a 403 with `error === "ScopeMissingError"`. */
function measuredShape(error = SCOPE_MISSING_ERROR_NAME, status = 403) {
  return {
    error,
    status,
    message: `Missing required scope "rpc:space.roomy.authComplete.arbiter.proxy?aud=..."`,
  };
}

describe("isInsufficientScopeError", () => {
  test("matches the measured 403 + ScopeMissingError shape", () => {
    assert.equal(isInsufficientScopeError(measuredShape()), true);
  });

  test("matches the message-only shape with a 403 (error name stripped by a transport)", () => {
    assert.equal(
      isInsufficientScopeError({
        status: 403,
        message: 'Missing required scope "rpc:space.roomy.auth.getSpaces"',
      }),
      true,
    );
  });

  test("matches the message-only shape regardless of scope token content", () => {
    assert.equal(
      isInsufficientScopeError({ status: 403, message: "Missing required scope" }),
      true,
    );
  });

  test("matches a 403 with the OAuth-spec resource-server names defensively", () => {
    for (const name of ["insufficient_scope", "insufficient_scope_required"]) {
      assert.equal(isInsufficientScopeError(measuredShape(name)), true);
    }
  });

  test("does NOT match invalid_scope — that is the AUTHORIZATION-server shape, not a mid-request scope miss", () => {
    assert.equal(isInsufficientScopeError(measuredShape("invalid_scope")), false);
  });

  test("does NOT match a 500 even with the ScopeMissingError name", () => {
    assert.equal(
      isInsufficientScopeError(measuredShape(SCOPE_MISSING_ERROR_NAME, 500)),
      false,
    );
  });

  test("does NOT match a plain Error (no status/error fields)", () => {
    assert.equal(
      isInsufficientScopeError(new Error("Missing required scope")),
      false,
    );
  });

  test("does NOT match a 403 with an unrelated error name", () => {
    assert.equal(isInsufficientScopeError(measuredShape("AuthRequired")), false);
    assert.equal(isInsufficientScopeError(measuredShape("InternalServerError")), false);
  });

  test("does NOT match the message-only shape without a 403", () => {
    assert.equal(
      isInsufficientScopeError({
        status: 500,
        message: 'Missing required scope "rpc:space.roomy.auth.getSpaces"',
      }),
      false,
    );
  });

  test("returns false for non-objects", () => {
    for (const v of [null, undefined, "string", 42, true]) {
      assert.equal(isInsufficientScopeError(v), false);
    }
  });
});

describe("guardedXrpc", () => {
  test("returns the call's value on success", async () => {
    const out = await guardedXrpc(() => Promise.resolve(42));
    assert.equal(out, 42);
  });

  test("surfaces a non-scope error without invoking the prompt", async () => {
    let prompted = false;
    await assert.rejects(
      guardedXrpc(() => Promise.reject(new Error("boom")), {
        requiredTier: "base",
        prompt: (_tier) => {
          prompted = true;
          return Promise.resolve(true);
        },
      }),
      /boom/,
    );
    assert.equal(prompted, false);
  });

  test("invokes the prompt on a recognised scope-miss and rethrows the error", async () => {
    let prompted: ScopeSetName | undefined;
    const err: unknown = measuredShape();
    await assert.rejects(
      guardedXrpc(() => Promise.reject(err), {
        requiredTier: "base",
        prompt: (tier) => {
          prompted = tier;
          return Promise.resolve(true);
        },
      }),
      // rethrows the SAME error object
      (e) => e === err,
    );
    assert.equal(prompted, "base");
  });

  test("does NOT invoke the prompt when the error is a 500 (no scope-miss)", async () => {
    let prompted = false;
    await assert.rejects(
      guardedXrpc(() => Promise.reject(measuredShape(SCOPE_MISSING_ERROR_NAME, 500)), {
        requiredTier: "base",
        prompt: (_tier) => {
          prompted = true;
          return Promise.resolve(true);
        },
      }),
    );
    assert.equal(prompted, false);
  });

  test("does NOT invoke the prompt when no requiredTier is given", async () => {
    let prompted = false;
    await assert.rejects(
      guardedXrpc(() => Promise.reject(measuredShape()), {
        prompt: (_tier) => {
          prompted = true;
          return Promise.resolve(true);
        },
      }),
    );
    assert.equal(prompted, false);
  });

  test("does NOT invoke the prompt when no prompt is injected", async () => {
    await assert.rejects(
      guardedXrpc(() => Promise.reject(measuredShape()), { requiredTier: "base" }),
    );
  });

  test("does not retry when the prompt accepts in-place (app-password: requestScopeExpansion is a no-op)", async () => {
    // Guard the anti-loop contract: a no-op expansion (test mode) must not
    // cause the guarded call to re-run and re-fail forever — it rethrows once.
    let calls = 0;
    let prompted = false;
    const prompt: ScopeExpansionPrompt = (_tier) => {
      prompted = true;
      return Promise.resolve(true); // requestScopeExpansion no-op; accepts
    };
    await assert.rejects(
      guardedXrpc(
        () => {
          calls++;
          return Promise.reject(measuredShape());
        },
        { requiredTier: "base", prompt },
      ),
    );
    assert.equal(calls, 1); // called once — never re-run
    assert.equal(prompted, true);
  });

  test("does not retry when the prompt declines", async () => {
    let calls = 0;
    let prompted = false;
    await assert.rejects(
      guardedXrpc(
        () => {
          calls++;
          return Promise.reject(measuredShape());
        },
        {
          requiredTier: "base",
          prompt: (_tier) => {
            prompted = true;
            return Promise.resolve(false); // declined
          },
        },
      ),
    );
    assert.equal(calls, 1);
    assert.equal(prompted, true);
  });
});
