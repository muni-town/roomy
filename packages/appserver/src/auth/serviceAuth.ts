/**
 * Appserver self-signed serviceAuth tokens.
 *
 * The appserver authenticates to the arbiter server by minting its own
 * serviceAuth JWTs, signed with the appserver's own signing key (exposed as a
 * `Multikey` verification method in the appserver's DID document). This is the
 * same token shape an ATProto OAuth session produces via
 * `com.atproto.server.getServiceAuth`, but self-signed because the appserver
 * is a `did:web` with no PDS to mint tokens for it.
 *
 * The arbiter validates these tokens by:
 *   - resolving the token `iss` (the appserver DID) DID document,
 *   - extracting the `Multikey` verification method named by the header `kid`
 *     (a `did:key:` string, matched against `publicKeyMultibase`),
 *   - verifying the ES256K signature (raw 64-byte compact r||s),
 *   - checking `aud` == arbiter server DID, `lxm` == request NSID, `iat` fresh,
 *     and `jti` unique (replay protection).
 *
 * See `crates/arbiter-server/src/auth.rs` in the leaf-0.4 repo.
 */

import { Secp256k1Keypair } from "@atproto/crypto";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { signingKeyPath } from "../db/paths.ts";

/** Token lifetime in seconds. The arbiter rejects tokens older than 5 minutes. */
const TOKEN_TTL_SEC = 60;

// ─── Key management ──────────────────────────────────────────────────────

let cachedKey: Secp256k1Keypair | null = null;

/**
 * Load the appserver signing key, generating + persisting one if absent.
 *
 * Precedence:
 *   1. `APPSERVER_SIGNING_KEY` env var (hex-encoded 32-byte private key).
 *   2. A persisted key file at `DATA_DIR/appserver-signing-key.hex` (unless
 *      `DATA_DIR=:memory:`, which means no filesystem).
 *
 * The key is cached process-wide after first load.
 */
export async function loadAppserverSigningKey(): Promise<Secp256k1Keypair> {
  if (cachedKey) return cachedKey;

  const envKey = process.env.APPSERVER_SIGNING_KEY;
  // Resolve lazily at call time so tests that set `DATA_DIR` in `beforeEach`
  // redirect the key file (a module-level const would pin the path at load).
  const keyPath = signingKeyPath();

  let hex: string | null = null;
  if (envKey) {
    hex = envKey;
  } else if (keyPath && existsSync(keyPath)) {
    hex = readFileSync(keyPath, "utf-8").trim();
  }

  let key: Secp256k1Keypair;
  if (hex) {
    key = await Secp256k1Keypair.import(hex, { exportable: true });
  } else {
    key = await Secp256k1Keypair.create({ exportable: true });
    if (keyPath) {
      const exported = await key.export();
      mkdirSync(dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, Buffer.from(exported).toString("hex"), { mode: 0o600 });
    }
  }

  cachedKey = key;
  return key;
}

/** Reset the cached key (test helper). */
export function _resetAppserverSigningKey(): void {
  cachedKey = null;
}

/**
 * The appserver's signing key as a `did:key:` string (the JWT header `kid`).
 */
export async function appserverSigningKeyDid(): Promise<string> {
  const key = await loadAppserverSigningKey();
  return key.did();
}

/**
 * The appserver's signing key as a multibase string (`z...`) for the DID
 * document's `Multikey` verification method `publicKeyMultibase` field.
 */
export async function appserverSigningKeyMultibase(): Promise<string> {
  const did = await appserverSigningKeyDid();
  return did.replace(/^did:key:/, "");
}

// ─── JWT minting ────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Mint a self-signed serviceAuth JWT for the appserver.
 *
 * @param aud - the audience DID (the arbiter server's DID).
 * @param lxm - the XRPC method NSID being called (e.g. `town.muni.arbiter.createArbiter`).
 * @param ownDid - the appserver's own DID (the token `iss`/`sub`).
 * @returns a signed JWT suitable for `Authorization: Bearer <token>`.
 */
export async function mintServiceAuth(
  aud: string,
  lxm: string,
  ownDid: string,
): Promise<string> {
  const key = await loadAppserverSigningKey();

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256K", typ: "JWT", kid: key.did() };
  const claims = {
    iss: ownDid,
    sub: ownDid,
    aud,
    lxm,
    iat: now,
    exp: now + TOKEN_TTL_SEC,
    jti: Buffer.from(randomBytes(16)).toString("hex"),
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header), "utf8"));
  const claimsB64 = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const signingInput = `${headerB64}.${claimsB64}`;

  const sig = await key.sign(Buffer.from(signingInput, "utf8"));
  return `${signingInput}.${base64url(sig)}`;
}
