import { describe, it, expect } from "vitest";
import { checkScopeMismatch } from "./scopeCheck";

describe("checkScopeMismatch", () => {
  it("returns null when all required scopes are granted", () => {
    const granted = "atproto blob:*/* rpc:net.openmeet.auth?aud=*";
    const required = "atproto blob:*/*";
    expect(checkScopeMismatch(granted, required)).toBeNull();
  });

  it("returns null when scopes match exactly", () => {
    const scope = "atproto blob:*/* rpc:net.openmeet.auth?aud=*";
    expect(checkScopeMismatch(scope, scope)).toBeNull();
  });

  it("returns missing scopes when required scopes are absent", () => {
    const granted = "atproto blob:*/*";
    const required = "atproto blob:*/* rpc:net.openmeet.auth?aud=*";
    expect(checkScopeMismatch(granted, required)).toEqual([
      "rpc:net.openmeet.auth?aud=*",
    ]);
  });

  it("returns multiple missing scopes", () => {
    const granted = "atproto";
    const required = "atproto blob:*/* rpc:net.openmeet.auth?aud=*";
    expect(checkScopeMismatch(granted, required)).toEqual([
      "blob:*/*",
      "rpc:net.openmeet.auth?aud=*",
    ]);
  });

  it("ignores scope ordering differences", () => {
    const granted = "blob:*/* atproto";
    const required = "atproto blob:*/*";
    expect(checkScopeMismatch(granted, required)).toBeNull();
  });

  it("handles extra whitespace gracefully", () => {
    const granted = "atproto  blob:*/*  ";
    const required = "atproto blob:*/*";
    expect(checkScopeMismatch(granted, required)).toBeNull();
  });

  it("handles empty granted scope", () => {
    const required = "atproto";
    expect(checkScopeMismatch("", required)).toEqual(["atproto"]);
  });

  it("handles empty required scope", () => {
    expect(checkScopeMismatch("atproto", "")).toBeNull();
  });

  it("handles both empty", () => {
    expect(checkScopeMismatch("", "")).toBeNull();
  });

  it("does not trigger re-auth when granted has extra scopes (scope removal)", () => {
    const granted = "atproto blob:*/* rpc:old.removed.scope?aud=*";
    const required = "atproto blob:*/*";
    expect(checkScopeMismatch(granted, required)).toBeNull();
  });
});
