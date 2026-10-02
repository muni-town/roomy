/**
 * JWS signing for the two native push providers, over WebCrypto.
 *
 * Both providers authenticate a request with a JWT signed by a key the
 * operator holds, and both reject anything signed with the wrong algorithm:
 * Apple accepts only `ES256` for its provider tokens, Google's OAuth2 token
 * endpoint only `RS256`. There is no library in the appserver's dependency
 * tree that signs either without bringing a key-management runtime, and Bun's
 * `crypto.subtle` implements both, so the signature is built here.
 *
 * The two providers disagree on claims and lifetime — Apple's token carries
 * only `iss`/`iat` (validity is bounded by `iat` age, with no `aud` or `exp`),
 * while Google requires `aud`, `exp` and `scope` — so this module owns only
 * what they share: PKCS#8 → signing key, and the `header.payload.signature`
 * envelope. Each transport supplies its own header and claims.
 */

/** The JWS algorithms the push providers accept. */
export type SigningAlgorithm = "ES256" | "RS256";

/**
 * Decode a PEM block to its DER bytes. An APNs `.p8` auth key and an FCM
 * service-account `private_key` are both PKCS#8 PEM, which is what WebCrypto
 * imports; the armour lines and any wrapping are not part of the key.
 *
 * Returned as a copy rather than as a `Buffer` view: WebCrypto takes an
 * `ArrayBuffer`-backed `BufferSource`, and a `Buffer` may be a view onto a
 * pooled backing store. Key material is a few hundred bytes, decoded once per
 * provider token, so the copy costs nothing.
 */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  // The envelope is required, not merely stripped: a value that is not PEM at
  // all (a truncated secret, a wrong variable) would otherwise leave arbitrary
  // text as the "body", base64-decode to garbage, and report as a usable key
  // right up until the first signature is rejected by the provider.
  const match = /-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/.exec(pem);
  const body = match?.[1]?.replace(/\s+/g, "");
  if (!body) {
    throw new Error("key is not a PEM block");
  }
  return new Uint8Array(Buffer.from(body, "base64"));
}

/**
 * Import a PKCS#8 key for `algorithm`. Imported per call rather than cached:
 * a provider token lives for tens of minutes (see each transport), so this
 * cost is paid once per token, not once per push.
 */
export async function importSigningKey(
  algorithm: SigningAlgorithm,
  der: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  if (algorithm === "ES256") {
    return crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Sign `header.claims` with `key`, returning the compact JWS. */
export async function signJwt(
  algorithm: SigningAlgorithm,
  key: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  // JWS uses the unpadded URL-safe base64 alphabet, which is what Node's
  // "base64url" emits (unlike `btoa` over a binary string).
  const encode = (value: unknown): string =>
    Buffer.from(new TextEncoder().encode(JSON.stringify(value))).toString(
      "base64url",
    );
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    algorithm === "ES256"
      ? { name: "ECDSA", hash: "SHA-256" }
      : { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  // WebCrypto returns an ECDSA signature as the raw `r || s` pair, which is
  // already the JWS ES256 wire format — no DER unwrapping needed.
  return `${signingInput}.${Buffer.from(new Uint8Array(signature)).toString("base64url")}`;
}
