/**
 * E2E coverage for the admin procedure:
 *   space.roomy.space.updatePolicy
 *
 * Re-applies the reference arbiter config on a space's stewarded account.
 * Requires admin access on the space. The appserver, as the arbiter recovery
 * admin, calls `town.muni.arbiter.resetConfig` with the reference config
 * (`REFERENCE_ARBITER_CONFIG` — the same config newly-provisioned spaces get).
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
import { REFERENCE_ARBITER_CONFIG } from "../arbiter/provision.ts";
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

/** Minimal mock arbiter that records resetConfig calls (reference config). */
async function startMockArbiter(): Promise<{
  server: HttpServer;
  configs: Array<{ trustedScopes: string[]; policyLayers: string[] }>;
}> {
  const configs: Array<{ trustedScopes: string[]; policyLayers: string[] }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/town.muni.arbiter.resetConfig")) {
        const body = (await req.json()) as {
          trustedScopes?: string[];
          policyLayers?: string[];
        };
        configs.push({
          trustedScopes: body.trustedScopes ?? [],
          policyLayers: body.policyLayers ?? [],
        });
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, configs };
}

describe("space.roomy.space.updatePolicy", () => {
  test("admin → re-applies the reference config on the stewarded account", async () => {
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

        // The arbiter received exactly one resetConfig with the reference
        // config (trusted scopes + policy layers, verbatim).
        expect(mock.configs).toHaveLength(1);
        expect(mock.configs[0]).toEqual({
          trustedScopes: REFERENCE_ARBITER_CONFIG.trustedScopes,
          policyLayers: REFERENCE_ARBITER_CONFIG.policyLayers,
        });
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
        // USER is a member but not an admin → forbidden, no config push.
        const res = await fetch(`http://localhost:${handle.port}/xrpc/space.roomy.space.updatePolicy`, {
          method: "POST",
          headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
          body: JSON.stringify({ spaceId: SPACE }),
        });
        expect(res.status).toBe(403);
        expect(mock.configs).toHaveLength(0);
      } finally {
        await handle.close();
      }
    } finally {
      mock.server.stop();
    }
  });
});
