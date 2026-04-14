import { verifyJwt } from "@atproto/xrpc-server";
import { IdResolver, getKey } from "@atproto/identity";
import { XrpcError } from "./errors.ts";
import type { AuthCtx } from "./types.ts";

export type AuthVerifier = (req: Request) => Promise<AuthCtx>;

// ── Identity resolution ──────────────────────────────────────────────────

const PLC_URL = process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";

export const idResolver = new IdResolver({
  plcUrl: PLC_URL,
});

// ── Production auth verifier ─────────────────────────────────────────────

const OWN_DID = process.env.APPSERVER_DID ?? "did:web:appserver.roomy.chat";

export const prodAuthVerifier: AuthVerifier = async (req) => {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new XrpcError(401, "AuthRequired", "Missing Bearer token");
  }
  const jwt = authHeader.slice(7);

  const payload = await verifyJwt(
    jwt,
    OWN_DID,
    null,
    async (iss: string, forceRefresh: boolean) => {
      const did = iss.split("#")[0]!;
      const didDoc = await idResolver.did.resolve(did, forceRefresh);
      if (!didDoc) {
        throw new XrpcError(401, "InvalidToken", `Could not resolve DID: ${did}`);
      }

      const didKey = getKey(didDoc);
      if (!didKey) {
        throw new XrpcError(401, "InvalidToken", "No ATProto signing key in DID document");
      }

      return didKey;
    },
  );

  return { did: payload.iss };
};

// ── Ticket store for WebSocket pre-auth ─────────────────────────────────

const tickets = new Map<string, { did: string; expiresAt: number }>();
const TICKET_TTL_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
}, 5 * 60 * 1000).unref();

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
