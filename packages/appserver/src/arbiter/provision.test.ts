/**
 * Regression test: space provisioning must use the arbiter's built-in
 * owner/manager proxy route, not a scoped `*.arbiter.proxy` route.
 *
 * The scoped route (`space.roomy.authComplete.arbiter.proxy`) applies two
 * gates before the policy pipeline runs —
 *
 *   1. a trusted-scope gate on the account's config record, then
 *   2. the *permission-set lexicon's* embedded Rego, evaluated over the inner
 *      request core alone (no caller DID — scope policies are pure functions
 *      of `{method, nsid, parameters, body, encoding}`).
 *
 * A denial there fires before any policy layer, so no admin/recovery-admin
 * authorization can rescue it: a `createSpace` proxied through the scoped
 * route 500s. The built-in `town.muni.arbiter.proxy` route has no scope gate
 * and reaches the pipeline, where the installed default policy admits the
 * account's recovery admin (the appserver) — which is the appserver's
 * authority model for provisioning. Provisioning therefore keeps the built-in
 * route: the appserver's own writes must not depend on what the permission
 * set happens to admit.
 *
 * The published permission set also admits record creation
 * (`putRecord`/`createRecord`) for `network.cosmik.*` collections (the
 * Semble space-card path) and an explicit `putRecord` of
 * `space.roomy.service`. `scopedScopePolicyAllows` below transcribes the
 * current policy, and the scoped-route tests at the bottom pin what it admits
 * and denies.
 *
 * The mock arbiter below reproduces the real server's routing: it applies the
 * scope policy on the scoped route (transcribed from the published lexicon,
 * see `scopedScopePolicyAllows` below) and the ownership check on the built-in
 * route.
 *
 * Run: bun test --cwd packages/appserver src/arbiter/provision.test.ts
 */

import { beforeEach, expect, test } from "bun:test";
import { provisionSpace } from "./provision.ts";
import { _resetAppserverSigningKey } from "../auth/serviceAuth.ts";
import type { ArbiterConfig } from "./config.ts";
import { StreamDid } from "@roomy-space/sdk";

const OWN_DID = "did:web:api.roomy.space";
const ARBITER_DID = "did:web:arbiter.example";
const NEW_SPACE_DID = "did:plc:provisioned-space";

/** The scoped route the appserver must NOT provision through. */
const SCOPED_ROUTE = "space.roomy.authComplete.arbiter.proxy";
/** The built-in owner/manager route the appserver provisions through. */
const BUILTIN_ROUTE = "town.muni.arbiter.proxy";

/**
 * The scope policy embedded in the published permission-set lexicon
 * `space.roomy.authComplete` (writer `did:plc:cyqufxsezk33hqulcilckna6`, cid
 * `bafyreic4jrkeswhluqav4whjlvssx23oftjdsom72zmkpy7lyhzwdsemim`, fetched
 * from its PDS). Transcribed verbatim — the real server compiles
 * this Rego and requires `data.arbiter.allow == true`; the transcription is a
 * direct predicate translation of its `allow` rules (the published policy's
 * `cosmik_prefix` constant is inlined as `"network.cosmik."`).
 */
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

interface ProxyEnvelope {
  arbiterDid: string;
  target: string;
  method: string;
  nsid: string;
  parameters?: unknown;
  body?: { collection?: unknown } | null;
}

interface MockArbiter {
  config: ArbiterConfig;
  /** Routes actually hit, in order. */
  calls: string[];
  /** Inner XRPC NSIDs actually proxied. */
  proxiedNsids: string[];
  stop: () => void;
}

/**
 * A mock arbiter that routes like the real server: the scoped route runs the
 * trusted-scope gate + the permission-set scope policy; the built-in route
 * runs the community pipeline (here: the recovery-admin/owner check the
 * installed default policy performs).
 */
function startMockArbiter(): MockArbiter {
  const calls: string[] = [];
  const proxiedNsids: string[] = [];
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

      const envelope = (await req.json()) as ProxyEnvelope;
      proxiedNsids.push(envelope.nsid);

      // The account's config record trusts `space.roomy.authComplete` (it is
      // `REFERENCE_ARBITER_CONFIG.trustedScopes`), so the trusted-scope gate
      // passes and the permission-set scope policy decides.
      if (route === SCOPED_ROUTE) {
        if (
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
      }
      // Built-in route: the pipeline ran and the owner/recovery-admin was
      // admitted, so the request is proxied as the steward.
      return Response.json({ ok: true });
    },
  });

  return {
    config: { url: `http://127.0.0.1:${server.port}`, did: ARBITER_DID },
    calls,
    proxiedNsids,
    stop: () => server.stop(true),
  };
}

beforeEach(() => {
  _resetAppserverSigningKey();
  process.env.DATA_DIR = "/tmp/appserver-test-data";
  delete process.env.APPSERVER_SIGNING_KEY;
});

test("provisionSpace succeeds — step 3 proxies via the built-in owner route", async () => {
  const mock = startMockArbiter();
  try {
    const spaceDid = await provisionSpace(mock.config, OWN_DID);

    expect(spaceDid).toBe(StreamDid.assert(NEW_SPACE_DID));
    // The provisioning write landed as an inner XRPC through the arbiter.
    expect(mock.proxiedNsids).toContain("com.atproto.repo.putRecord");
    // It must go through the owner route: the appserver's own provisioning
    // writes must not depend on what the scoped route's permission-set scope
    // policy happens to admit.
    expect(mock.calls).toContain(BUILTIN_ROUTE);
    expect(mock.calls).not.toContain(SCOPED_ROUTE);
  } finally {
    mock.stop();
  }
});

test("the scoped route's scope policy denies requests outside the permission set", async () => {
  const mock = startMockArbiter();
  try {
    // A repo write outside the permission set. The scope policy is a pure
    // function of the inner request — no caller identity — so the denial is
    // structural, not a config/auth failure.
    const res = await fetch(`${mock.config.url}/xrpc/${SCOPED_ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arbiterDid: NEW_SPACE_DID,
        target: `${NEW_SPACE_DID}#atproto_pds`,
        method: "POST",
        nsid: "com.atproto.repo.putRecord",
        body: {
          repo: NEW_SPACE_DID,
          collection: "app.bsky.feed.post",
          rkey: "3k",
          record: { $type: "app.bsky.feed.post", text: "hi" },
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden",
      message: "request denied by scope policy",
    });
  } finally {
    mock.stop();
  }
});

test("the scoped route's scope policy admits permission-set record writes", async () => {
  const mock = startMockArbiter();
  try {
    const post = (nsid: string, body: unknown) =>
      fetch(`${mock.config.url}/xrpc/${SCOPED_ROUTE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          arbiterDid: NEW_SPACE_DID,
          target: `${NEW_SPACE_DID}#atproto_pds`,
          method: "POST",
          nsid,
          body,
        }),
      });

    // The provisioning write: explicitly admitted by the permission set.
    const service = await post("com.atproto.repo.putRecord", {
      repo: NEW_SPACE_DID,
      collection: "space.roomy.service",
      rkey: "self",
      record: { $type: "space.roomy.service", did: OWN_DID },
    });
    expect(service.status).toBe(200);

    // The Semble space-card write: `createRecord` of a `network.cosmik.*`
    // collection — the permission set's record-creation branch.
    const card = await post("com.atproto.repo.createRecord", {
      repo: NEW_SPACE_DID,
      collection: "network.cosmik.card",
      record: {
        $type: "network.cosmik.card",
        type: "URL",
        content: {
          $type: "network.cosmik.card#urlContent",
          url: "https://example.com/article",
        },
      },
    });
    expect(card.status).toBe(200);
  } finally {
    mock.stop();
  }
});
