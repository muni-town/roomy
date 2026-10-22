/**
 * Stub ATProto PDS for E2E runs.
 *
 * The app-lite client's test-mode auth path (`PUBLIC_TEST_IDENTIFIER` +
 * `PUBLIC_TEST_APP_PASSWORD`) runs the REAL `AtpAgent.login()` and the REAL
 * `ServiceAuthClient.getToken()` — it only swaps out the server it talks to
 * (`PUBLIC_PDS`). Pointing that at this stub means the suite exercises the
 * genuine client auth/session/token code with no network, no real account and
 * no credentials.
 *
 * Serves the endpoints the client's own code calls, plus the repo read/write
 * surface a feature that stores records in the user's own repo needs:
 *   - `com.atproto.server.createSession` → a session for the fixed test DID
 *   - `com.atproto.server.getServiceAuth` → a short-lived token
 *   - `com.atproto.repo.createRecord` / `putRecord` / `deleteRecord` — an
 *     in-memory repo, so a spec can drive a real record round-trip (write it,
 *     read it back, delete it) through the client's own code.
 *   - `com.atproto.repo.listRecords` / `getRecord` → reads of that repo
 *
 * Writes are authorized against the session's granted scope, the way a real
 * PDS does: a write the grant does not cover is refused with a 403 — the
 * refusal the consent dialogue exists to catch. The grant starts at the base
 * tier, and a spec widens it over the control endpoint below.
 *
 * The refusal is emitted in the shape the deployed server sends, which is
 * **not** the PDS's own: the web client's XRPC calls run through HappyView, and
 * HappyView's forward-time scope check (`src/xrpc/scope_check.rs`) answers a
 * miss with the human sentence in the `error` field and no error name at all.
 * Modelling the PDS's `ScopeMissingError` — a shape that topology cannot
 * produce — is what let a suite stay green while the deployed app showed a raw
 * error toast. The PDS's own shape is still real on the direct-PDS path
 * (desktop, legacy client), so the stub can emit either; a spec selects over
 * `/__e2e/refusal-shape` and the default is the deployed one.
 *
 * The appserver never verifies these tokens: it boots with
 * `APPSERVER_TEST_MODE=true`, whose `testAuthVerifier` reads the caller's DID
 * from the `X-Test-Did` header instead (injected by the Playwright fixture).
 * The tokens exist so the client's own auth code runs unmodified.
 *
 * The record store exists for the opposite reason: a write to the user's own
 * repo goes through this stub, so the only way to prove the record landed is
 * for the stub to keep it and hand it back. Records are stored in memory and
 * survive for the run.
 */

import type { Server } from "bun";
import { SCOPE_SETS } from "../src/lib/scopes.ts";
import {
  PDS_PORT,
  TEST_USER_DID,
  TEST_USER_HANDLE,
} from "./fixtures.ts";

/** Base64url encode a JSON payload (the stub tokens are never verified). */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Mint an unsigned JWT. `ServiceAuthClient` reads `exp` and nothing else. */
export function mintStubJwt(lifetimeSeconds = 300): string {
  const header = encodeSegment({ alg: "none", typ: "JWT" });
  const payload = encodeSegment({
    iss: TEST_USER_DID,
    sub: TEST_USER_DID,
    aud: TEST_USER_DID,
    exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
  });
  return `${header}.${payload}.stub-signature`;
}

/** One record in the stub repo, addressed by `repo/collection/rkey`. */
export interface StubRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

/** The stub's repo contents, keyed by `repo/collection/rkey`. */
const repo = new Map<string, StubRecord>();

/**
 * A real, parseable CIDv1 (dag-cbor + sha2-256) used for every stub record.
 *
 * The client validates repo responses against the atproto lexicon, which
 * format-checks `cid` fields, so this has to be a valid CID rather than an
 * arbitrary marker string. Its value is never dereferenced.
 */
const STUB_CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";

/** The key a record is stored under. */
function keyOf(repoDid: string, collection: string, rkey: string): string {
  return `${repoDid}/${collection}/${rkey}`;
}

/**
 * Every record in one collection of one repo, newest rkey last.
 *
 * Exported so a spec running in the same process could read the repo
 * directly; specs normally assert through the client and a `listRecords`
 * call instead, so the assertion covers what the app actually wrote.
 */
export function stubListRecords(
  repoDid: string,
  collection: string,
): StubRecord[] {
  return [...repo.values()]
    .filter((r) => r.uri.startsWith(`at://${repoDid}/${collection}/`))
    .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
}

/** Empty the stub repo (a spec that needs a clean slate calls this). */
export function stubClearRecords(): void {
  repo.clear();
}

/**
 * One record from the stub repo, as a PDS `getRecord` would return its value.
 *
 * The appserver reads a user's Roomy profile record from their PDS, so the
 * stack launcher wires this in place of the network call (see
 * `_setTestGetRoomyProfileRecord` in `launch-stack.ts`): what the client wrote
 * to the stub is what the appserver reads back.
 *
 * `$bytes` fields are base64url-decoded here because a real PDS decodes them
 * from CBOR on the way out, while this stub keeps records as the JSON the
 * client posted. `getProfile` feeds the record to a lexicon validator that
 * requires a byte array, so the encoded form would be rejected as an invalid
 * response.
 */
export function stubGetRecord(
  repoDid: string,
  collection: string,
  rkey: string,
): { uri: string; cid: string; value: Record<string, unknown> } | null {
  const found = repo.get(keyOf(repoDid, collection, rkey));
  if (!found) return null;
  return { ...found, value: decodeBytes(found.value) };
}

/** Recursively replace `{ $bytes: <base64url> }` with the bytes it encodes. */
function decodeBytes(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return value.map(decodeBytes) as unknown as Record<string, unknown>;
  }
  if (typeof value !== "object" || value === null) {
    return value as Record<string, unknown>;
  }
  const record = value as Record<string, unknown>;
  const encoded = record["$bytes"];
  if (typeof encoded === "string") {
    return Buffer.from(encoded, "base64url") as unknown as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = decodeBytes(entry);
  return out;
}

export interface PdsStub {
  server: Server<unknown>;
  origin: string;
  stop(): void;
}

/** The base32-sortable alphabet a TID is drawn from. */
const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/** Mint a record key the way a PDS does: a sortable, unique TID. */
function mintRkey(): string {
  // The first character is restricted to the first 14 symbols, so the TID
  // sorts by time; the rest are free.
  let rkey = TID_CHARS[Math.floor(Math.random() * 14)]!;
  for (let i = 1; i < 13; i++) {
    rkey += TID_CHARS[Math.floor(Math.random() * TID_CHARS.length)]!;
  }
  return rkey;
}

/** Start the stub PDS on the fixed `PDS_PORT`. */
export function startPdsStub(): PdsStub {
  // The page's origin (`:5181`) is cross-origin to this stub (`:4599`), so
  // every call from the browser is subject to CORS — including the preflight
  // for the JSON `createSession` POST. Without these headers the browser
  // blocks the login before it is sent.
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Atproto-Proxy",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  function json(body: unknown, status = 200): Response {
    return Response.json(body, { status, headers: corsHeaders });
  }

  // ── Resource-server scope enforcement ────────────────────────────────
  // A real resource server authorizes a repo write against the scope the
  // session was granted, and refuses a write the grant does not cover with a
  // 403 — the refusal the consent dialogue exists to catch. Without this the
  // stub would accept every write, the refusal that triggers the dialogue could
  // never occur, and the tier's whole contract would be untestable.
  //
  // The grant starts as the base tier (test-mode sessions have no OAuth token,
  // and the client treats them as holding the tier it requested), so
  // `network.cosmik.card` is exactly the write the base grant does not cover.
  // A spec widens it over the control endpoint below once it is testing the
  // write rather than the gate.
  let grantedScope = new Set(SCOPE_SETS.base.split(" ").filter(Boolean));

  /**
   * How a refusal is written onto the wire. Two topologies, two shapes:
   *
   *   - `happyview` — the deployed web client's calls run through HappyView,
   *     whose forward-time scope check (`src/xrpc/scope_check.rs`) answers a
   *     miss with `error` set to the human sentence and no error name.
   *   - `pds` — a direct-PDS session (desktop, legacy client) gets
   *     `@atproto/oauth-scopes`'s `ScopeMissingError` carried through
   *     `@atproto/xrpc-server`.
   *
   * Defaults to the deployed one: it is what real users meet, so the suite must
   * exercise it unless a spec deliberately selects the other.
   */
  let refusalShape: "happyview" | "pds" = "happyview";

  /** The 403 body for a write the session's grant does not cover. */
  function scopeRefusal(method: string, collection: string): Record<string, unknown> {
    const token = `repo:${collection}?action=create`;
    if (refusalShape === "pds") {
      return {
        error: "ScopeMissingError",
        message: `Missing required scope "${token}"`,
      };
    }
    return {
      error:
        `this session is not authorized for ${method}: ` +
        `it needs ${token}. Scopes are fixed when a session is created, so ` +
        `this needs a new authorization with the scope included.`,
    };
  }
  /** The `repo:` grant for a collection, as the OAuth scope grammar writes it. */
  const repoScopeAllowsWrite = (collection: string): boolean =>
    grantedScope.has(`repo:${collection}`) ||
    grantedScope.has(`repo:${collection}?action=create`) ||
    grantedScope.has(`repo:${collection}?action=*`);

  /** The in-memory repo endpoints, keyed by the XRPC method. */
  async function handleRepo(
    method: string,
    req: Request,
    params: URLSearchParams,
  ): Promise<Response> {
    // `createRecord` and `putRecord` share the write and the scope gate; the
    // difference (PDS-assigned vs caller-supplied rkey) is the only behaviour
    // a spec observes here.
    if (
      method === "com.atproto.repo.putRecord" ||
      method === "com.atproto.repo.createRecord"
    ) {
      const body = (await req.json()) as {
        repo: string;
        collection: string;
        rkey?: string;
        record: Record<string, unknown>;
      };
      // The scope gate: the grant this session holds decides whether the write
      // is authorized, exactly as a real resource server enforces it. A miss is
      // a 403 in the shape the running topology would send — the refusal the
      // client turns into the consent dialogue.
      if (!repoScopeAllowsWrite(body.collection)) {
        return json(scopeRefusal(method, body.collection), 403);
      }
      const rkey = body.rkey ?? mintRkey();
      // A real CID literal, not a stand-in string: the client validates the
      // response against the atproto lexicon, which format-checks `cid` fields,
      // so a made-up value fails the write on the client side before any
      // assertion runs. The value itself is never interpreted — it only has to
      // parse.
      const uri = `at://${body.repo}/${body.collection}/${rkey}`;
      const cid = STUB_CID;
      repo.set(keyOf(body.repo, body.collection, rkey), {
        uri,
        cid,
        value: body.record,
      });
      // `putRecord` also reports the commit. Its `rev` is format-checked as a
      // TID, so it is a freshly minted one — the caller-supplied rkey is not a
      // TID for every collection (`space.roomy.user.profile` uses `self`), and
      // reusing it would fail the client's validation of the response.
      // `createRecord`'s output carries no commit.
      if (method === "com.atproto.repo.putRecord") {
        return json({ uri, cid, commit: { cid, rev: mintRkey() } });
      }
      return json({ uri, cid });
    }

    if (method === "com.atproto.repo.deleteRecord") {
      const body = (await req.json()) as {
        repo: string;
        collection: string;
        rkey: string;
      };
      repo.delete(keyOf(body.repo, body.collection, body.rkey));
      return json({ commit: { cid: STUB_CID, rev: body.rkey } });
    }

    if (method === "com.atproto.repo.listRecords") {
      const repoDid = params.get("repo") ?? "";
      const collection = params.get("collection") ?? "";
      const limit = Number(params.get("limit") ?? "50");
      const all = stubListRecords(repoDid, collection);
      const start = params.get("cursor") ? Number(params.get("cursor")) : 0;
      const page = all.slice(start, start + limit);
      const next = start + page.length;
      return json({
        records: page.map(({ uri, cid, value }) => ({ uri, cid, value })),
        ...(next < all.length ? { cursor: String(next) } : {}),
      });
    }

    if (method === "com.atproto.repo.getRecord") {
      const found = repo.get(
        keyOf(
          params.get("repo") ?? "",
          params.get("collection") ?? "",
          params.get("rkey") ?? "",
        ),
      );
      if (!found) {
        return json(
          { error: "RecordNotFound", message: "Could not locate record" },
          400,
        );
      }
      return json({ uri: found.uri, cid: found.cid, value: found.value });
    }

    return json(
      { error: "NotFound", message: `No stub repo route for ${method}` },
      404,
    );
  }

  const server = Bun.serve({
    port: PDS_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const { pathname, searchParams } = new URL(req.url);

      // ── Test control ──────────────────────────────────────────────────
      // Settable grant: a spec observes the refusal first (the session holds
      // base), then grants the `semble` tier the way the consent round-trip
      // would, and observes the same write land. Nothing in the app reaches
      // this endpoint — only the specs' own `page.request`.
      if (pathname === "/__e2e/granted-scope") {
        if (req.method === "POST") {
          const { scope } = (await req.json()) as { scope?: string };
          grantedScope = new Set((scope ?? "").split(" ").filter(Boolean));
        }
        return json({ scope: [...grantedScope].join(" ") });
      }

      if (pathname === "/__e2e/records") {
        return json({ records: [...repo.values()] });
      }

      // Which shape a scope refusal is written in. The two write paths differ
      // — deployed web calls run through HappyView, a direct-PDS session talks
      // to the PDS — so the suite proves the predicate against both. Only the
      // specs reach this; the app never does.
      if (pathname === "/__e2e/refusal-shape") {
        if (req.method === "POST") {
          const { shape } = (await req.json()) as { shape?: string };
          if (shape !== "happyview" && shape !== "pds") {
            return json({ error: "InvalidRequest", message: `no shape ${shape}` }, 400);
          }
          refusalShape = shape;
        }
        return json({ shape: refusalShape });
      }

      if (!pathname.startsWith("/xrpc/")) {
        return json(
          { error: "NotFound", message: `No stub route for ${pathname}` },
          404,
        );
      }
      const method = pathname.slice("/xrpc/".length);

      if (method === "com.atproto.server.createSession") {
        return json({
          accessJwt: mintStubJwt(),
          refreshJwt: mintStubJwt(86_400),
          handle: TEST_USER_HANDLE,
          did: TEST_USER_DID,
          email: "e2e@roomy.test",
          active: true,
        });
      }

      if (method === "com.atproto.server.getServiceAuth") {
        return json({ token: mintStubJwt() });
      }

      if (method.startsWith("com.atproto.repo.")) {
        return await handleRepo(method, req, searchParams);
      }

      return json(
        { error: "NotFound", message: `No stub route for ${pathname}` },
        404,
      );
    },
  });

  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
