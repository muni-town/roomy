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
 */
import { describe, it, expect } from "vitest";
import { authorizeRequestOptions } from "./oauth-options";

describe("authorizeRequestOptions", () => {
  it("returns undefined when neither state nor scope is set", () => {
    expect(authorizeRequestOptions({})).toBeUndefined();
  });

  it("forwards scope when set — the case that keeps the ceiling out of the request", () => {
    const opts = authorizeRequestOptions({ scope: "atproto repo:x.y" });
    expect(opts).toEqual({ scope: "atproto repo:x.y" });
  });

  it("forwards state when set", () => {
    expect(authorizeRequestOptions({ state: "/space/1" })).toEqual({
      state: "/space/1",
    });
  });

  it("forwards both when both are set", () => {
    expect(
      authorizeRequestOptions({ state: "/space/1", scope: "atproto" }),
    ).toEqual({ state: "/space/1", scope: "atproto" });
  });

  it("omits a null/empty state rather than passing an empty key", () => {
    // `login()` always computes a return URL, but a caller may pass null; an
    // empty `state` must not override the client's default.
    expect(authorizeRequestOptions({ state: null })).toBeUndefined();
    expect(authorizeRequestOptions({ state: "" })).toBeUndefined();
  });

  it("omits an empty scope rather than passing an empty key", () => {
    // An empty `scope` key would be sent as `scope=` and is never intended.
    expect(authorizeRequestOptions({ scope: "" })).toBeUndefined();
  });
});
