/**
 * E2E coverage for space provisioning through the arbiter:
 *   POST space.roomy.space.createSpace
 *
 * Boots the real appserver (test-mode auth) against a local mock arbiter that
 * reproduces the deployed server's routing, then exercises the full HTTP path:
 *
 *   createSpace → StreamManager.createStream → provisionSpace
 *     → createArbiter, resetConfig, proxy (step 3)
 *   → seed events → membership → getSpaces reflects the new space
 *
 * The mock arbiter enforces what the deployed one does: the scoped
 * `space.roomy.authComplete.arbiter.proxy` route applies the permission-set
 * scope policy, while the built-in `town.muni.arbiter.proxy` route reaches
 * the pipeline. Provisioning must keep using the built-in route so the
 * appserver's own writes never depend on what the permission set happens to
 * admit (the production outage was a provisioning putRecord the then-current
 * scope policy denied — see `src/arbiter/provision.test.ts` for the
 * unit-level pin and the transcribed current policy).
 *
 * Run: bun test --cwd packages/appserver src/e2e/createSpace.test.ts
 */

import { describe, expect, test } from "bun:test";
import { createAppserver, type AppserverHandle } from "../appserver.ts";
import { testAuthVerifier } from "../xrpc/auth.ts";
import { closeDb, openDb } from "../db/db.ts";
import { _resetRateLimit } from "../xrpc/rateLimit.ts";
import { _resetEmbedSweeper } from "../embed/sweeper.ts";
import { _resetStreamManager } from "../streams/StreamManager.ts";
import { _resetProfileStoreCache } from "../queries/profileStore.ts";
import { _resetProfileNegativeCache } from "../materialization/profiles.ts";
import type { ArbiterConfig } from "../arbiter/config.ts";
import type { Database } from "bun:sqlite";

const USER = "did:plc:e2e-createspace-user";
const OWN_DID = "did:web:api.roomy.space";
const NEW_SPACE_DID = "did:plc:create-space-e2e";

const SCOPED_ROUTE = "space.roomy.authComplete.arbiter.proxy";
const BUILTIN_ROUTE = "town.muni.arbiter.proxy";

/** The scope policy of the published `space.roomy.authComplete` permission-set
 *  lexicon, transcribed verbatim from its PDS (source cid + provenance in
 *  `src/arbiter/provision.test.ts`; the published policy's `cosmik_prefix`
 *  constant is inlined as `"network.cosmik."`). */
function scopedScopePolicyAllows(inner: {
  nsid: string;
  body: { collection?: unknown } | null;
}): boolean {
  if (inner.nsid.startsWith("space.roomy.")) return true;
  if (inner.nsid.startsWith("network.cosmik.")) return true;
  if (inner.nsid === "com.atproto.repo.uploadBlob") return true;
  if (inner.nsid === "com.atproto.identity.updateHandle") return true;
  // Record creation (putRecord/createRecord) is admitted for
  // `network.cosmik.*` collections — e.g. Semble space cards.
  if (
    (inner.nsid === "com.atproto.repo.putRecord" ||
      inner.nsid === "com.atproto.repo.createRecord") &&
    typeof inner.body?.collection === "string" &&
    inner.body.collection.startsWith("network.cosmik.")
  ) {
    return true;
  }
  return (
    inner.nsid === "com.atproto.repo.putRecord" &&
    (inner.body?.collection === "app.bsky.actor.profile" ||
      inner.body?.collection === "space.roomy.service")
  );
}

interface MockArbiter {
  config: ArbiterConfig;
  calls: string[];
  stop: () => void;
}

/** Mock arbiter routing like the deployed server (scope gate on the scoped
 *  route; pipeline on the built-in route). */
function startMockArbiter(): MockArbiter {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const route = url.pathname.replace(/^\/xrpc\//, "");
      calls.push(route);

      if (route === "town.muni.arbiter.createArbiter") {
        return Response.json({ did: NEW_SPACE_DID });
      }
      if (route === "town.muni.arbiter.resetConfig") {
        return Response.json({ ok: true });
      }
      if (route !== SCOPED_ROUTE && route !== BUILTIN_ROUTE) {
        return new Response("not found", { status: 404 });
      }
      const envelope = (await req.json()) as {
        nsid: string;
        body?: { collection?: unknown } | null;
      };
      if (
        route === SCOPED_ROUTE &&
        !scopedScopePolicyAllows({
          nsid: envelope.nsid,
          body: envelope.body ?? null,
        })
      ) {
        return Response.json(
          { error: "Forbidden", message: "request denied by scope policy" },
          { status: 403 },
        );
      }
      // The pipeline admitted the caller (recovery admin) and proxied as the
      // steward.
      return Response.json({ ok: true });
    },
  });

  return {
    config: {
      url: `http://127.0.0.1:${server.port}`,
      did: "did:web:arbiter.example",
    },
    calls,
    stop: () => server.stop(true),
  };
}

describe("space.roomy.space.createSpace (via arbiter)", () => {
  test("returns 200 and the space appears in the caller's getSpaces", async () => {
    const mock = startMockArbiter();
    try {
      closeDb();
      _resetRateLimit();
      _resetEmbedSweeper();
      _resetStreamManager();
      _resetProfileStoreCache();
      _resetProfileNegativeCache();
      openDb({ path: ":memory:" }) as unknown as Database;

      const handle: AppserverHandle = await createAppserver({
        authVerifier: testAuthVerifier,
        port: 0,
        dbPath: ":memory:",
        readStateDbPath: ":memory:",
        quiet: true,
        ownDid: OWN_DID,
        arbiter: mock.config,
        disableBackgroundWorkers: true,
        getProfiles: async () => [],
      });

      try {
        const base = `http://localhost:${handle.port}`;

        const created = await fetch(
          `${base}/xrpc/space.roomy.space.createSpace`,
          {
            method: "POST",
            headers: { "X-Test-Did": USER, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "E2E Arbiter Space" }),
          },
        );
        // With the current permission set the scoped route would also admit
        // the step-3 write, so the routing assertions below are what catch a
        // regression to the scoped route.
        expect(created.status).toBe(200);
        const createdBody = (await created.json()) as { spaceId?: string };
        expect(createdBody.spaceId).toBe(NEW_SPACE_DID);

        // Provisioning used the built-in owner route, not the scoped one.
        expect(mock.calls).toContain(BUILTIN_ROUTE);
        expect(mock.calls).not.toContain(SCOPED_ROUTE);

        // The new space is visible to its creator.
        const spacesRes = await fetch(
          `${base}/xrpc/space.roomy.space.getSpaces?limit=50`,
          { headers: { "X-Test-Did": USER } },
        );
        expect(spacesRes.status).toBe(200);
        const spaces = (await spacesRes.json()) as {
          spaces?: Array<{ id?: string; spaceId?: string }>;
        };
        const ids = (spaces.spaces ?? []).map((s) => s.id ?? s.spaceId);
        expect(ids).toContain(NEW_SPACE_DID);

        // A new space is suggested by default: an omitted field resolves to
        // true at the API boundary, and getMetadata reflects the stored value.
        const metaRes = await fetch(
          `${base}/xrpc/space.roomy.space.getMetadata?spaceId=${NEW_SPACE_DID}`,
          { headers: { "X-Test-Did": USER } },
        );
        expect(metaRes.status).toBe(200);
        const meta = (await metaRes.json()) as { suggestToOthers?: boolean };
        expect(meta.suggestToOthers).toBe(true);
      } finally {
        await handle.close();
      }
    } finally {
      mock.stop();
    }
  });
});
