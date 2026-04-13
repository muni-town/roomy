import { secp256k1 } from "@noble/curves/secp256k1";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { fromBase58Btc } from "@atcute/multibase";
import { webDidToDocumentUrl, getAtprotoVerificationMaterial } from "@atcute/identity";
import type { DidDocument } from "@atcute/identity";
import { XrpcError } from "./errors.ts";
import type { AuthCtx } from "./types.ts";

export type AuthVerifier = (req: Request) => Promise<AuthCtx>;

// ── DID document resolution ────────────────────────────────────────────────

const PLC_URL = process.env.PLC_DIRECTORY_URL ?? "https://plc.directory";
const didDocCache = new Map<string, { doc: DidDocument; expiresAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [did, entry] of didDocCache) {
    if (entry.expiresAt <= now) didDocCache.delete(did);
  }
}, 10 * 60 * 1000).unref();

async function resolveDidDoc(did: string): Promise<DidDocument> {
  const cached = didDocCache.get(did);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;

  let url: string;
  if (did.startsWith("did:plc:")) {
    url = `${PLC_URL}/${did}`;
  } else if (did.startsWith("did:web:")) {
    url = webDidToDocumentUrl(did as `did:web:${string}`).toString();
  } else {
    throw new XrpcError(401, "InvalidToken", `Unsupported DID method: ${did}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new XrpcError(
      401,
      "InvalidToken",
      `Failed to resolve DID: ${did} (HTTP ${res.status})`,
    );
  }
  const doc = (await res.json()) as DidDocument;
  didDocCache.set(did, { doc, expiresAt: Date.now() + CACHE_TTL_MS });
  return doc;
}

// ── Key extraction ─────────────────────────────────────────────────────────

// Varint-encoded multicodec prefixes for compressed EC public keys
const SECP256K1_CODEC = new Uint8Array([0xe7, 0x01]);
const P256_CODEC = new Uint8Array([0x80, 0x24]);

function extractPublicKeyBytes(
  type: string,
  publicKeyMultibase: string,
): { keyBytes: Uint8Array; alg: "ES256K" | "ES256" } {
  if (!publicKeyMultibase.startsWith("z")) {
    throw new XrpcError(401, "InvalidToken", "Unsupported multibase encoding (expected base58btc)");
  }
  const decoded = fromBase58Btc(publicKeyMultibase.slice(1));

  if (type === "Multikey") {
    if (decoded[0] === SECP256K1_CODEC[0] && decoded[1] === SECP256K1_CODEC[1]) {
      return { keyBytes: decoded.slice(2), alg: "ES256K" };
    }
    if (decoded[0] === P256_CODEC[0] && decoded[1] === P256_CODEC[1]) {
      return { keyBytes: decoded.slice(2), alg: "ES256" };
    }
    const b0 = decoded[0]?.toString(16) ?? "??";
    const b1 = decoded[1]?.toString(16) ?? "??";
    throw new XrpcError(401, "InvalidToken", `Unsupported Multikey codec: 0x${b0}${b1}`);
  }
  if (type === "EcdsaSecp256k1VerificationKey2019") {
    return { keyBytes: decoded, alg: "ES256K" };
  }
  if (type === "EcdsaSecp256r1VerificationKey2019") {
    return { keyBytes: decoded, alg: "ES256" };
  }
  throw new XrpcError(401, "InvalidToken", `Unsupported verification method type: ${type}`);
}

// ── JWT parsing and signature verification ─────────────────────────────────

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new XrpcError(401, "InvalidToken", "Malformed JWT");
  const [, payloadB64] = parts;
  try {
    return JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
  } catch {
    throw new XrpcError(401, "InvalidToken", "Malformed JWT payload");
  }
}

function verifyJwtSignature(
  jwt: string,
  keyBytes: Uint8Array,
  alg: "ES256K" | "ES256",
): void {
  const parts = jwt.split(".");
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) {
    throw new XrpcError(401, "InvalidToken", "Malformed JWT");
  }
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const msgHash = sha256(signingInput);
  const sigBytes = new Uint8Array(Buffer.from(sigB64, "base64url").buffer);

  if (sigBytes.byteLength !== 64) {
    throw new XrpcError(401, "InvalidToken", "Invalid signature length");
  }

  let valid: boolean;
  if (alg === "ES256K") {
    const sig = secp256k1.Signature.fromCompact(sigBytes);
    valid = secp256k1.verify(sig, msgHash, keyBytes);
  } else {
    const sig = p256.Signature.fromCompact(sigBytes);
    valid = p256.verify(sig, msgHash, keyBytes);
  }

  if (!valid) throw new XrpcError(401, "InvalidToken", "Signature verification failed");
}

// ── Production auth verifier ───────────────────────────────────────────────

const OWN_DID = process.env.APPSERVER_DID ?? "did:web:appserver.roomy.chat";

export const prodAuthVerifier: AuthVerifier = async (req) => {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new XrpcError(401, "AuthRequired", "Missing Bearer token");
  }
  const jwt = authHeader.slice(7);

  const payload = decodeJwtPayload(jwt);
  const { iss, aud, exp } = payload as { iss?: unknown; aud?: unknown; exp?: unknown };

  if (typeof iss !== "string" || !iss.startsWith("did:")) {
    throw new XrpcError(401, "InvalidToken", "Missing or invalid iss claim");
  }
  if (aud !== OWN_DID) {
    throw new XrpcError(401, "InvalidToken", "Audience mismatch");
  }
  if (typeof exp !== "number" || exp < Math.floor(Date.now() / 1000)) {
    throw new XrpcError(401, "InvalidToken", "Token expired");
  }

  const didDoc = await resolveDidDoc(iss);
  const material = getAtprotoVerificationMaterial(didDoc);
  if (!material) {
    throw new XrpcError(401, "InvalidToken", "No ATProto signing key in DID document");
  }

  const { keyBytes, alg } = extractPublicKeyBytes(material.type, material.publicKeyMultibase);
  verifyJwtSignature(jwt, keyBytes, alg);

  return { did: iss };
};

// ── Ticket store for WebSocket pre-auth ───────────────────────────────────

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
