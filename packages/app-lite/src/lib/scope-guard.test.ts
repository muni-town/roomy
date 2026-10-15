/**
 * Unit tests for `scope-guard.ts` — the reactive consent-flow decisions that
 * `auth.svelte.ts` / the dialogue wiring apply (kept out of the `svelte.ts`
 * and `.svelte` modules so they run under app-lite's
 * `node --test --experimental-strip-types` runner).
 *
 * Pins two contracts:
 *
 *   - `isInsufficientScopeError` — the narrow predicate that matches *only* the
 *     resource-server scope-misses a session can hit: the PDS's
 *     `error === "ScopeMissingError"` / `Missing required scope "…"` shapes at
 *     `status === 403`, and the sentence HappyView's forward-time check puts in
 *     a 403's `error` field on the deployed web path. It must NOT match a
 *     request-time `invalid_scope`, a server 500, a plain Error, a 403 with an
 *     unrelated name or sentence, or any of those shapes without a 403 — a
 *     predicate that matches everything is precisely the failure Phase 5
 *     exists to prevent.
 *   - `guardedXrpc` — runs the call, and only on a recognised scope-miss for a
 *     `requiredScope` + prompt invokes the prompt. It hands the prompt the tier
 *     as declared, requestable or ceiling-only, so the choice of dialogue stays
 *     in one place; it never retries, so even a no-op `requestScopeExpansion`
 *     (app-password/test mode) cannot loop.
 *   - `SCOPE_UNAVAILABLE_EXPLANATION` — the notice's copy, which must stay
 *     honest about a permission no sign-in can supply yet.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isInsufficientScopeError,
  SCOPE_MISSING_ERROR_NAME,
  SCOPE_UNAVAILABLE_EXPLANATION,
  guardedXrpc,
  type ScopePrompt,
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

/**
 * The shape the deployed web client meets: HappyView's forward-time scope check
 * refuses with `status === 403` and the human sentence as the whole `error`
 * field — no error name, no separate `message`.
 */
function happyViewShape(
  sentence =
    `this session is not authorized for com.atproto.repo.createRecord: it ` +
    `needs repo:network.cosmik.card?action=create. Scopes are fixed when a ` +
    `session is created, so this needs a new authorization with the scope ` +
    `included.`,
  status = 403,
) {
  return { error: sentence, status };
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

  test("matches HappyView's 403 shape — the whole sentence in the error field, no name", () => {
    // The deployed web client's calls run through HappyView, whose forward-time
    // scope check writes its refusal as the `error` value itself
    // (`src/xrpc/scope_check.rs`); there is no error name and no `message`
    // field, so a name-keyed predicate never opens the dialogue in production.
    assert.equal(isInsufficientScopeError(happyViewShape()), true);
  });

  test("does NOT match a 403 whose sentence is unrelated", () => {
    assert.equal(
      isInsufficientScopeError(happyViewShape("this session cannot delete that record")),
      false,
    );
  });

  test("does NOT match HappyView's sentence without a 403", () => {
    assert.equal(isInsufficientScopeError(happyViewShape(undefined, 500)), false);
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
        requiredScope: "base",
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
        requiredScope: "base",
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
        requiredScope: "base",
        prompt: (_tier) => {
          prompted = true;
          return Promise.resolve(true);
        },
      }),
    );
    assert.equal(prompted, false);
  });

  test("invokes the prompt on HappyView's refusal — the path a deployed web write takes", async () => {
    let prompted: ScopeSetName | undefined;
    await assert.rejects(
      guardedXrpc(() => Promise.reject(happyViewShape()), {
        requiredScope: "semble",
        prompt: (tier) => {
          prompted = tier;
          return Promise.resolve(false);
        },
      }),
    );
    assert.equal(prompted, "semble");
  });

  test("hands a ceiling-only tier to the prompt unchanged, so the notice can say Roomy cannot request it", async () => {
    // `blocks` is declared in the metadata ceiling but not registered on the
    // deployed API client. This guard does not know that — it forwards the tier
    // and the prompt decides from `isRequestableScopeSet`, which is what lets one
    // flow cover a requestable tier and a deferred one.
    let prompted: ScopeSetName | undefined;
    const err: unknown = measuredShape();
    await assert.rejects(
      guardedXrpc(() => Promise.reject(err), {
        requiredScope: "blocks",
        prompt: (tier) => {
          prompted = tier;
          return Promise.resolve(false);
        },
      }),
      (e) => e === err,
    );
    assert.equal(prompted, "blocks");
  });

  test("does not retry the write after the unavailable-scope notice", async () => {
    // The notice resolves without a consent, because there is none to give. The
    // write must stay failed: a retry could only fail the same way, and a caller
    // that read it as success would report a block that was never written.
    let calls = 0;
    let prompted = false;
    await assert.rejects(
      guardedXrpc(
        () => {
          calls++;
          return Promise.reject(measuredShape());
        },
        {
          requiredScope: "blocks",
          prompt: (_tier) => {
            prompted = true;
            return Promise.resolve(false);
          },
        },
      ),
    );
    assert.equal(prompted, true);
    assert.equal(calls, 1);
  });

  test("does NOT invoke the prompt when no requiredScope is given", async () => {
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
      guardedXrpc(() => Promise.reject(measuredShape()), { requiredScope: "base" }),
    );
  });

  test("does not retry when the prompt accepts in-place (app-password: requestScopeExpansion is a no-op)", async () => {
    // Guard the anti-loop contract: a no-op expansion (test mode) must not
    // cause the guarded call to re-run and re-fail forever — it rethrows once.
    let calls = 0;
    let prompted = false;
    const prompt: ScopePrompt = (_tier) => {
      prompted = true;
      return Promise.resolve(true); // requestScopeExpansion no-op; accepts
    };
    await assert.rejects(
      guardedXrpc(
        () => {
          calls++;
          return Promise.reject(measuredShape());
        },
        { requiredScope: "base", prompt },
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
          requiredScope: "base",
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

describe("SCOPE_UNAVAILABLE_EXPLANATION", () => {
  test("says Roomy cannot request the permission, and never offers a sign-in that cannot grant it", () => {
    // The copy this replaces told the user to sign in again — a dead end, since
    // a session's granted scope is fixed for its life and no round-trip can ask
    // for a scope the client refuses. Any sentence that mentions signing in must
    // deny that it helps.
    assert.match(SCOPE_UNAVAILABLE_EXPLANATION, /cannot ask for this permission/i);
    for (const sentence of SCOPE_UNAVAILABLE_EXPLANATION.split(". ")) {
      if (/\b(?:sign|log)\s?(?:ing )?(?:in|out)\b/i.test(sentence)) {
        assert.match(
          sentence,
          /\b(?:not|won't|cannot|can't)\b/i,
          `a sentence naming sign-in must deny it helps: "${sentence}"`,
        );
      }
    }
  });
});
