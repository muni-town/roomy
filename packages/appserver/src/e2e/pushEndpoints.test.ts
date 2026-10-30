/**
 * Push endpoint coverage (preferences + subscriptions). These read/write the
 * read-state DB, so no materialization is needed — they're exercised through
 * the real HTTP transport with test auth.
 *
 * Run: bun test --cwd packages/appserver src/e2e/pushEndpoints.test.ts
 */

import { describe, expect, test } from "bun:test";
import { openReadStateDb } from "../db/db.ts";
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

describe("space.roomy.push.registerSubscription (sse)", () => {
  const registerSse = (ctx: E2eContext, did: string, endpoint: string) =>
    ctx.authedFetch(did)(
      `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
      { method: "POST", body: JSON.stringify({ endpoint, kind: "sse" }) },
    );

  const deviceId = (n: number) =>
    `device-${String(n).padStart(2, "0")}-AbCdEfGhIjKlMnOp`;

  const sseEndpoints = async (did: string) =>
    (
      await openReadStateDb()
        .query("select endpoint from push_subscriptions where user_did = ? and kind = 'sse'")
        .all<{ endpoint: string }>(did)
    ).map((row) => row.endpoint);

  test("which client ids an sse registration accepts", async () => {
    const ctx = await startAppserver();
    const candidates: Array<[label: string, id: string, expected: number]> = [
      ["a UUID", "3f2b8c1e-9d4a-4e6b-8a1f-2c7d5e9b0a13", 200],
      ["16 random bytes as base64url", "q83vEq7mR1xk0Zb9TfNwXA", 200],
      ["a 43 character id", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ", 200],
      ["21 characters", "q83vEq7mR1xk0Zb9TfNwX", 400],
      ["66 characters", "q83vEq7mR1xk0Zb9TfNwXA".repeat(3), 400],
      ["characters outside the url-safe set", "q83vEq7mR1xk0Zb9TfNwX+/A", 400],
      ["one character repeated", "a".repeat(32), 400],
      ["two distinct characters", "ab".repeat(16), 400],
      ["22 hex characters", "0123456789abcdef012345", 200],
    ];

    const actual: Array<[string, number]> = [];
    for (const [label, id] of candidates) {
      actual.push([label, (await registerSse(ctx, USER, id)).status]);
    }

    expect(actual).toEqual(candidates.map(([label, , expected]) => [label, expected]));
  });

  test("an 11th device evicts the one updated longest ago", async () => {
    const ctx = await startAppserver();
    for (let n = 0; n < 10; n += 1) {
      expect((await registerSse(ctx, USER, deviceId(n))).status).toBe(200);
    }
    // Spread the rows over distinct times so "oldest" is well defined: device
    // 0 is the stalest, device 9 the freshest.
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (let n = 0; n < 10; n += 1) {
      await openReadStateDb().run(
        "update push_subscriptions set updated_at = ? where user_did = ? and endpoint = ?",
        dayAgo + n * 1000,
        USER,
        deviceId(n),
      );
    }

    expect((await registerSse(ctx, USER, deviceId(10))).status).toBe(200);

    const remaining = await sseEndpoints(USER);
    expect(remaining).toHaveLength(10);
    expect(remaining).not.toContain(deviceId(0));
    expect(remaining).toContain(deviceId(10));
  });

  test("a registration is never the device it evicts, even when timestamps tie", async () => {
    const ctx = await startAppserver();
    for (let n = 0; n < 10; n += 1) {
      expect((await registerSse(ctx, USER, deviceId(n))).status).toBe(200);
    }
    // Put every existing row in the current second, so the new row ties with
    // them: `updated_at` has whole-second resolution.
    await openReadStateDb().run(
      "update push_subscriptions set updated_at = unixepoch() * 1000 where user_did = ?",
      USER,
    );

    expect((await registerSse(ctx, USER, deviceId(10))).status).toBe(200);

    const remaining = await sseEndpoints(USER);
    expect(remaining).toHaveLength(10);
    expect(remaining).toContain(deviceId(10));
  });
});
