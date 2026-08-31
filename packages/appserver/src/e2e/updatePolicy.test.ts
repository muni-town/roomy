/**
 * E2E coverage for the admin procedure:
 *   space.roomy.space.updatePolicy
 *
 * Reinstalls the appserver's latest arbiter policy on a space's stewarded
 * account. Requires admin access on the space. The appserver, as the arbiter
 * recovery admin, calls `town.muni.arbiter.resetPolicy` with the current
 * default policy (which lets Roomy admins act under the space's account).
 *
 * Run: bun test --cwd packages/appserver src/e2e/updatePolicy.test.ts
 */

import { describe, expect, test } from "bun:test";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetRateLimit } from "../xrpc/rateLimit.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { _resetProfileStoreCache } from "../queries/profileStore.ts";
import type { ArbiterConfig } from "../arbiter/config.ts";
import { DEFAULT_ARBITER_POLICY } from "../arbiter/policy.ts";
import type { Database } from "bun:sqlite";
import { seedSpace, spaceDb } from "./helpers.ts";

const ADMIN = "did:plc:e2e-admin";
const USER = "did:plc:e2e-user";
const SPACE = "did:web:space-e2e.example";
const OWN_DID = "did:web:api.roomy.space";

/** Seed an admin edge (head = space, tail = user) in the space's per-space DB. */
function seedAdmin(db: Database, spaceId: string, did: string): void {
  const sp = spaceDb(db, spaceId);
  sp.run("insert or ignore into entities (id, stream_id) values (?, ?)", [did, did]);
  sp.run(
    "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
    [spaceId, did],
  );
}

/** A Bun HTTP server (here: a mock arbiter). */
type HttpServer = ReturnType<typeof Bun.serve>;

/** Minimal mock arbiter that records resetPolicy calls (latest policy). */
async function startMockArbiter(): Promise<{
  server: HttpServer;
  policies: string[];
}> {
  const policies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/town.muni.arbiter.resetPolicy")) {
        const body = await req.json() as { policy?: string };
        if (typeof body.policy === "string") policies.push(body.policy);
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, policies };
}

describe("space.roomy.space.updatePolicy", () => {
  test("admin → reinstalls latest policy on the stewarded account", async () => {
    const mock = await startMockArbiter();
    try {
      closeDb();
      _resetRateLimit();
      _resetHydrationInflight();
      _resetEmbedSweeper();
      _resetProfileStoreCache();
      const db = openDb({ path: ":memory:" }) as unknown as Database;
      seedSpace(db, SPACE, USER);
      seedAdmin(db, SPACE, ADMIN);

      const arbiter: ArbiterConfig = {
        url: `http://127.0.0.1:${mock.server.port}`,
        did: "did:web:arbiter.example",
      };
      const handle: AppserverHandle = await createAppserver({
        authVerifier: testAuthVerifier,
        port: 0,
        dbPath: ":memory:",
        readStateDbPath: ":memory:",
        quiet: true,
        ownDid: OWN_DID,
        arbiter,
        // Pure admin-procedure test: no embed/search/push loops needed.
        disableBackgroundWorkers: true,
      });

      try {
        const res = await fetch(`http://localhost:${handle.port}/xrpc/space.roomy.space.updatePolicy`, {
          method: "POST",
          headers: { "X-Test-Did": ADMIN, "Content-Type": "application/json" },
          body: JSON.stringify({ spaceId: SPACE }),
        });
        expect(res.status).toBe(200);

        // The arbiter received exactly one resetPolicy with the latest policy
        // (substituted with the appserver DID + XRPC endpoint).
        expect(mock.policies).toHaveLength(1);
        expect(mock.policies[0]).toBe(
          DEFAULT_ARBITER_POLICY.replaceAll("${owner}", OWN_DID),
        );
      } finally {
        await handle.close();
      }
    } finally {
      mock.server.stop();
    }
  });

  test("non-admin → 403", async () => {
    const mock = await startMockArbiter();
    try {
      closeDb();
      _resetRateLimit();
      _resetHydrationInflight();
      _resetEmbedSweeper();
      _resetProfileStoreCache();
      const db = openDb({ path: ":memory:" }) as unknown as Database;
      seedSpace(db, SPACE, USER);
      seedAdmin(db, SPACE, ADMIN);

      const arbiter: ArbiterConfig = {
        url: `http://127.0.0.1:${mock.server.port}`,
        did: "did:web:arbiter.example",
      };
      const handle: AppserverHandle = await createAppserver({
        authVerifier: testAuthVerifier,
        port: 0,
        dbPath: ":memory:",
        readStateDbPath: ":memory:",
        quiet: true,
        ownDid: OWN_DID,
        arbiter,
        // Pure admin-procedure test: no embed/search/push loops needed.
        disableBackgroundWorkers: true,
      });

      try {
        // USER is a member but not an admin → forbidden, no policy push.
        const res = await fetch(`http://localhost:${handle.port}/xrpc/space.roomy.space.updatePolicy`, {
          method: "POST",
          headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
          body: JSON.stringify({ spaceId: SPACE }),
        });
        expect(res.status).toBe(403);
        expect(mock.policies).toHaveLength(0);
      } finally {
        await handle.close();
      }
    } finally {
      mock.server.stop();
    }
  });
});
