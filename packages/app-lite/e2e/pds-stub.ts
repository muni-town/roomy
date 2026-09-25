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
 * Serves exactly the two endpoints that path calls:
 *   - `com.atproto.server.createSession` → a session for the fixed test DID
 *   - `com.atproto.server.getServiceAuth` → a short-lived token
 *
 * The appserver never verifies these tokens: it boots with
 * `APPSERVER_TEST_MODE=true`, whose `testAuthVerifier` reads the caller's DID
 * from the `X-Test-Did` header instead (injected by the Playwright fixture).
 * The tokens exist so the client's own auth code runs unmodified.
 */

import type { Server } from "bun";
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

export interface PdsStub {
  server: Server<unknown>;
  origin: string;
  stop(): void;
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

  const server = Bun.serve({
    port: PDS_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const { pathname } = new URL(req.url);

      if (pathname === "/xrpc/com.atproto.server.createSession") {
        return Response.json(
          {
            accessJwt: mintStubJwt(),
            refreshJwt: mintStubJwt(86_400),
            handle: TEST_USER_HANDLE,
            did: TEST_USER_DID,
            email: "e2e@roomy.test",
            active: true,
          },
          { headers: corsHeaders },
        );
      }

      if (pathname === "/xrpc/com.atproto.server.getServiceAuth") {
        return Response.json({ token: mintStubJwt() }, { headers: corsHeaders });
      }

      return Response.json(
        { error: "NotFound", message: `No stub route for ${pathname}` },
        { status: 404, headers: corsHeaders },
      );
    },
  });

  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
