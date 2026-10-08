/**
 * Unit tests for `authorizeRequestOptions` — the pure seam that decides what
 * `login()`/`tauriLogin()` forward into the PDS authorization request.
 *
 * The contract that matters: `scope` must be forwarded whenever it is set.
 * `@atproto/oauth-client`'s `authorize()` resolves
 * `options?.scope ?? clientMetadata.scope`, so a dropped `scope` silently
 * becomes the client metadata's *ceiling* — every scope Roomy may ever want,
 * including tiers the caller withheld (e.g. the `withDms` chat scopes app-lite
 * deliberately keeps out of first login). These tests fail if the helper ever
 * stops forwarding a set `scope`, or turns a falsy value into a present-but-
 * empty key (which would override a default with "").
 *
 * And the second half: `state` is NEVER forwarded. Both PDS clients generate
 * their own random `state` and store the matching authorization session under
 * it; a caller-supplied value replaces that generation, which is how a
 * one-character page path became the OAuth `state` and broke sign-in at every
 * PDS that enforces the entropy the spec asks for. `login()` keeps the return
 * URL in its own storage; the protocol parameter stays the client's.
 */
import { describe, it, expect } from "vitest";
import { authorizeRequestOptions } from "./oauth-options";

describe("authorizeRequestOptions", () => {
  it("returns undefined when no scope is set", () => {
    expect(authorizeRequestOptions({})).toBeUndefined();
  });

  it("forwards scope when set — the case that keeps the ceiling out of the request", () => {
    const opts = authorizeRequestOptions({ scope: "atproto repo:x.y" });
    expect(opts).toEqual({ scope: "atproto repo:x.y" });
  });

  it("never forwards a state — it is the OAuth client's parameter", () => {
    // The helper's param type has no `state`, but a plain-JS caller can still
    // pass one; it must be dropped rather than handed to the OAuth client,
    // where it would replace the client's own random value.
    const opts = authorizeRequestOptions({
      scope: "atproto",
      state: "/space/1",
    } as unknown as { scope: string });
    expect(opts).toEqual({ scope: "atproto" });
    expect(opts).not.toHaveProperty("state");
  });

  it("returns undefined when no scope is set, even if other keys are", () => {
    const opts = authorizeRequestOptions({
      state: "/space/1",
    } as unknown as Record<string, string>);
    expect(opts).toBeUndefined();
  });

  it("omits an empty scope rather than passing an empty key", () => {
    // An empty `scope` key would be sent as `scope=` and is never intended.
    expect(authorizeRequestOptions({ scope: "" })).toBeUndefined();
  });
});
