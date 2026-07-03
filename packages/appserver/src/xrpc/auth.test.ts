import { describe, expect, test } from "bun:test";
import { testAuthVerifier, selectAuthVerifier } from "./auth.ts";

describe("testAuthVerifier", () => {
  test("returns the DID from X-Test-Did header", async () => {
    const req = new Request("https://example.com/xrpc/test", {
      headers: { "X-Test-Did": "did:plc:test-user-123" },
    });
    const ctx = await testAuthVerifier(req);
    expect(ctx.did).toBe("did:plc:test-user-123");
  });

  test("returns null DID when no X-Test-Did header", async () => {
    const req = new Request("https://example.com/xrpc/test");
    const ctx = await testAuthVerifier(req);
    expect(ctx.did).toBeNull();
  });

  test("returns null DID when X-Test-Did is empty", async () => {
    const req = new Request("https://example.com/xrpc/test", {
      headers: { "X-Test-Did": "" },
    });
    const ctx = await testAuthVerifier(req);
    expect(ctx.did).toBeNull();
  });

  test("does not touch the Authorization header (no JWT verification)", async () => {
    // A garbage bearer token must NOT cause an error or change the result —
    // the test verifier ignores Authorization entirely.
    const req = new Request("https://example.com/xrpc/test", {
      headers: {
        Authorization: "Bearer not.a.real.jwt",
        "X-Test-Did": "did:plc:admin-user",
      },
    });
    const ctx = await testAuthVerifier(req);
    expect(ctx.did).toBe("did:plc:admin-user");
  });
});

describe("selectAuthVerifier", () => {
  test("returns testAuthVerifier when APPSERVER_TEST_MODE=true", () => {
    const orig = process.env.APPSERVER_TEST_MODE;
    process.env.APPSERVER_TEST_MODE = "true";
    try {
      expect(selectAuthVerifier()).toBe(testAuthVerifier);
    } finally {
      if (orig === undefined) delete process.env.APPSERVER_TEST_MODE;
      else process.env.APPSERVER_TEST_MODE = orig;
    }
  });

  test("returns prodAuthVerifier when APPSERVER_TEST_MODE is not true", () => {
    const orig = process.env.APPSERVER_TEST_MODE;
    process.env.APPSERVER_TEST_MODE = "false";
    try {
      // prodAuthVerifier is a different function object
      expect(selectAuthVerifier()).not.toBe(testAuthVerifier);
    } finally {
      if (orig === undefined) delete process.env.APPSERVER_TEST_MODE;
      else process.env.APPSERVER_TEST_MODE = orig;
    }
  });
});