/**
 * Tests for the appserver's self-signed serviceAuth tokens.
 *
 * Verifies the token shape matches what the arbiter server validates
 * (see `crates/arbiter-server/src/auth.rs` in leaf-0.4):
 *   - header: `alg: "ES256K"`, `kid` = the signing key's `did:key:` string
 *   - claims: `iss` = appserver DID, `aud` = arbiter DID, `lxm` = NSID,
 *     `iat`/`exp` present, `jti` present
 *   - signature: ES256K (secp256k1) over `header.claims`, verifiable against
 *     the `Multikey` verification method exposed in the DID document
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { verifySignature } from "@atproto/crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mintServiceAuth,
  appserverSigningKeyDid,
  appserverSigningKeyMultibase,
  _resetAppserverSigningKey,
} from "./serviceAuth.ts";

const ARBITER_DID = "did:web:arbiter.example.com";
const NSID = "town.muni.arbiter.createArbiter";
const OWN_DID = "did:web:api.roomy.space";

function decodePart(b64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
}

beforeEach(() => {
  _resetAppserverSigningKey();
  // Use a temp data dir so tests don't touch the real data dir.
  process.env.DATA_DIR = "/tmp/appserver-test-data";
  delete process.env.APPSERVER_SIGNING_KEY;
});

describe("mintServiceAuth", () => {
  test("produces a 3-part JWT with ES256K header and correct kid", async () => {
    const token = await mintServiceAuth(ARBITER_DID, NSID, OWN_DID);
    const [headerB64, , sigB64] = token.split(".");

    const header = decodePart(headerB64!);
    expect(header.alg).toBe("ES256K");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(await appserverSigningKeyDid());
    // Signature is present and non-empty.
    expect(sigB64).toBeTruthy();
  });

  test("claims carry iss/aud/lxm/iat/exp/jti", async () => {
    const token = await mintServiceAuth(ARBITER_DID, NSID, OWN_DID);
    const [, claimsB64] = token.split(".");
    const claims = decodePart(claimsB64!);

    expect(claims.iss).toBe(OWN_DID);
    expect(claims.sub).toBe(OWN_DID);
    expect(claims.aud).toBe(ARBITER_DID);
    expect(claims.lxm).toBe(NSID);
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect(typeof claims.jti).toBe("string");
    // exp is shortly after iat (60s TTL).
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
  });

  test("signature verifies against the DID-doc multibase key", async () => {
    const token = await mintServiceAuth(ARBITER_DID, NSID, OWN_DID);
    const [headerB64, claimsB64, sigB64] = token.split(".");

    // Reconstruct the signing key from the DID-doc multibase (what the arbiter
    // does: resolve DID doc → extract Multikey publicKeyMultibase → verify).
    const didKey = await appserverSigningKeyDid();

    const signingInput = `${headerB64}.${claimsB64}`;
    const sig = Buffer.from(sigB64!, "base64url");

    // Use @atproto/crypto's verify against the did:key (the arbiter's
    // `identify_key` + `validate` path).
    const ok = await verifySignature(
      didKey,
      Buffer.from(signingInput, "utf8"),
      sig,
    );
    expect(ok).toBe(true);
  });

  test("multibase is a valid did:key public key", async () => {
    const multibase = await appserverSigningKeyMultibase();
    expect(multibase.startsWith("z")).toBe(true);
    // Reconstruct the did:key and confirm it matches the keypair's did().
    expect(`did:key:${multibase}`).toBe(await appserverSigningKeyDid());
  });
});

describe("appserver signing key persistence", () => {
  test("DATA_DIR=:memory: mints a key without touching the filesystem", async () => {
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = ":memory:";
    _resetAppserverSigningKey();
    try {
      const did = await appserverSigningKeyDid();
      expect(did.startsWith("did:key:")).toBe(true);
      // `:memory:` is the no-filesystem sentinel (as for the DBs): a literal
      // `:memory:/` directory in the working tree would be swept into commits.
      expect(existsSync(join(process.cwd(), ":memory:"))).toBe(false);
    } finally {
      process.env.DATA_DIR = prev;
      _resetAppserverSigningKey();
    }
  });

  test("DATA_DIR=<dir> persists the key to the data dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "appserver-key-"));
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    _resetAppserverSigningKey();
    try {
      const did = await appserverSigningKeyDid();
      const keyPath = join(dir, "appserver-signing-key.hex");
      expect(existsSync(keyPath)).toBe(true);

      // The persisted key is the one that was loaded.
      _resetAppserverSigningKey();
      expect(await appserverSigningKeyDid()).toBe(did);
    } finally {
      process.env.DATA_DIR = prev;
      _resetAppserverSigningKey();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
