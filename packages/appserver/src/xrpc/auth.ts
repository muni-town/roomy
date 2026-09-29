import { verifyJwt } from "@atproto/xrpc-server";
import { getKey } from "@atproto/identity";
import { idResolver } from "../identity.ts";
import { XrpcError } from "./errors.ts";
import type { AuthCtx } from "./types.ts";

export type AuthVerifier = (req: Request) => Promise<AuthCtx>;

// ── Production auth verifier ─────────────────────────────────────────────

const OWN_DID = process.env.APPSERVER_DID ?? "did:web:api.roomy.space";

export const prodAuthVerifier: AuthVerifier = async (req) => {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    // No token — treat as anonymous. Handlers decide what anonymous callers
    // are allowed to do based on the null DID.
    return { did: null };
  }
  const jwt = authHeader.slice(7);

  try {
    const payload = await verifyJwt(
      jwt,
      OWN_DID,
      null,
      async (iss: string, forceRefresh: boolean) => {
        // Resolve through identity.ts's shared DID cache, so the issuer's
        // document is fetched at most once per cache window per process.
        // `forceRefresh` is verifyJwt's retry after a signature mismatch, so a
        // rotated signing key is honoured by the token that needs it.
        const did = iss.split("#")[0]!;
        const didDoc = await idResolver.did.resolve(did, forceRefresh);
        if (!didDoc) {
          throw new XrpcError(
            401,
            "InvalidToken",
            `Could not resolve DID: ${did}`,
          );
        }

        const didKey = getKey(didDoc);
        if (!didKey) {
          throw new XrpcError(
            401,
            "InvalidToken",
            "No ATProto signing key in DID document",
          );
        }

        return didKey;
      },
    );

    // Service auth tokens (from DirectXrpcClient) have `iss` = PDS DID and
    // `sub` = user DID. Atproto-proxy auth tokens have `iss` = user DID and
    // no `sub`. Use `sub` when present (service auth), fall back to `iss`
    // (atproto-proxy auth).
    const userDid = (payload as Record<string, unknown>).sub ?? payload.iss;
    return { did: userDid as string };
  } catch {
    // JWT verification failed (e.g. audience mismatch, expired, unknown issuer).
    // Fall back to anonymous — handlers enforce access control via
    // requireRoomRead / requireSpaceAccess.
    return { did: null };
  }
};

// ── Test auth verifier ───────────────────────────────────────────────────

/**
 * Auth verifier for E2E / integration testing. Bypasses JWT verification and
 * PLC DID resolution entirely — the caller's DID is read from a header,
 * `X-Test-Did`, so tests can impersonate any user without a real PDS or
 * network. Never enable in production: it accepts any DID without proof.
 *
 * Behaviour:
 * - `X-Test-Did: <did>`  → authenticated as that DID (no verification).
 * - No header, or empty  → anonymous (`{ did: null }`), same as prod.
 *
 * Guarded by an env flag so importing this module in a non-test process
 * is a no-op. The factory (`createAppserver`) selects this verifier when
 * `APPSERVER_TEST_MODE=true`.
 */
export const testAuthVerifier: AuthVerifier = async (req) => {
  const did = req.headers.get("x-test-did");
  if (!did) return { did: null };
  return { did };
};

/**
 * Select the appropriate auth verifier based on env. Test mode takes
 * precedence so a test harness never accidentally hits the network.
 */
export function selectAuthVerifier(): AuthVerifier {
  if (process.env.APPSERVER_TEST_MODE === "true") return testAuthVerifier;
  return prodAuthVerifier;
}

// ── Ticket store for WebSocket pre-auth ─────────────────────────────────

const tickets = new Map<string, { did: string; expiresAt: number }>();
const TICKET_TTL_MS = 60_000;

setInterval(
  () => {
    const now = Date.now();
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= now) tickets.delete(ticket);
    }
  },
  5 * 60 * 1000,
).unref();

export function issueTicket(did: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const ticket = Buffer.from(bytes).toString("hex");
  tickets.set(ticket, { did, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

export function consumeTicket(ticket: string): string {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry || entry.expiresAt < Date.now()) {
    throw new XrpcError(401, "InvalidToken", "Ticket not found or expired");
  }
  return entry.did;
}
