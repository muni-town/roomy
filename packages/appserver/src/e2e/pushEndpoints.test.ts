/**
 * Push endpoint coverage (preferences + subscriptions). These read/write the
 * read-state DB, so no materialization is needed — they're exercised through
 * the real HTTP transport with test auth.
 *
 * Run: bun test --cwd packages/appserver src/e2e/pushEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { startAppserver, type E2eContext } from "./helpers.ts";

const USER = "did:plc:e2e-user";

describe("space.roomy.push.getPreferences", () => {
  test("returns 200 with defaults for a user", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.getPreferences`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("default");
    expect(body).toHaveProperty("perSpace");
  });

  test("anonymous → 401", async () => {
    const ctx = await startAppserver();
    const res = await ctx.anonFetch(
      `${ctx.baseUrl}/xrpc/space.roomy.push.getPreferences`,
    );
    expect(res.status).toBe(401);
  });
});

describe("space.roomy.push.setPreferences", () => {
  test("sets a default level", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.setPreferences`,
      { method: "POST", body: JSON.stringify({ default: "quiet" }) },
    );
    expect(res.status).toBe(200);
  });

  test("invalid level → 400", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.setPreferences`,
      { method: "POST", body: JSON.stringify({ default: "nope" }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("space.roomy.push.getVapidPublicKey", () => {
  test("returns 200 with a publicKey (possibly empty in test)", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.getVapidPublicKey`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("publicKey");
  });
});

describe("space.roomy.push.registerSubscription / unregisterSubscription", () => {
  const sub = (endpoint: string) => ({
    endpoint,
    keys: { p256dh: "c2hhMjU2LWRlbW8", auth: "YXV0aC1kZW1v" },
  });

  test("register + unregister round-trips", async () => {
    const ctx = await startAppserver();
    const endpoint = "https://push.example/endpoint-1";
    const reg = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
      { method: "POST", body: JSON.stringify(sub(endpoint)) },
    );
    expect(reg.status).toBe(200);

    const unreg = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.unregisterSubscription`,
      { method: "POST", body: JSON.stringify({ endpoint }) },
    );
    expect(unreg.status).toBe(200);
  });

  test("register with invalid keys → 400", async () => {
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
      { method: "POST", body: JSON.stringify({ endpoint: "https://push.example/x", keys: {} }) },
    );
    expect(res.status).toBe(400);
  });

  test("a webpush registration without keys → 400", async () => {
    // Delivery cannot proceed without the RFC 8291 keypair, so storing the row
    // would promise a push that can never be encrypted.
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
      { method: "POST", body: JSON.stringify({ endpoint: "https://push.example/no-keys" }) },
    );
    expect(res.status).toBe(400);
  });

  test("a native registration carries a token and no keys", async () => {
    const ctx = await startAppserver();
    const endpoint = "apns-device-token-0123456789abcdef";
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
      { method: "POST", body: JSON.stringify({ endpoint, kind: "apns" }) },
    );
    expect(res.status).toBe(200);
  });

  test("an unknown kind → 400 rather than a stored, undeliverable row", async () => {
    // A row naming a transport this build doesn't run is counted as a failure
    // on every delivery, which hides a typo behind a runtime symptom.
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
      { method: "POST", body: JSON.stringify({ endpoint: "token", kind: "windows-wns" }) },
    );
    expect(res.status).toBe(400);
  });

  test("a browser client that predates `kind` still registers", async () => {
    // The field is optional so an already-deployed client keeps working
    // unchanged; omitting it must mean `webpush`, not a rejected request.
    const ctx = await startAppserver();
    const res = await ctx.authedFetch(USER)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
      {
        method: "POST",
        body: JSON.stringify(sub("https://push.example/legacy-client")),
      },
    );
    expect(res.status).toBe(200);
  });
});
