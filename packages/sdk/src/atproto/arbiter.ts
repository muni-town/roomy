import type { Agent } from "@atproto/api";
import { ArbiterProxyError } from "../transport/errors";

/**
 * Arbiter (leaf-0.4) client for acting on a space's stewarded account.
 *
 * A space's stewarded account lives on a PDS the client does not hold
 * credentials for. The only way to reach that PDS is through the space's
 * arbiter, via the `town.muni.arbiter.proxy` procedure: the caller mints a
 * short-lived serviceAuth token (`aud` = the arbiter server DID, `lxm` =
 * `town.muni.arbiter.proxy`), sends the proxy request to the arbiter server,
 * and the arbiter evaluates it against the space's Rego policy — which grants
 * the space's Roomy admins access — then proxies it to the stewarded account's
 * PDS authenticated as that account.
 *
 * Discovery: the arbiter server is not hard-coded. For each space, we read the
 * space's `town.muni.arbiter.service/self` record (from its PDS) to learn the
 * arbiter server's DID, then derive the server's HTTP origin from that DID.
 *
 * TODO: For now we convert the arbiter `did:web` directly to an `https://`
 * origin. Long-term we should resolve the arbiter server's DID document and
 * read its `#arbiter` service endpoint instead, so the origin isn't assumed to
 * be at the DID's host.
 */

/** A single proxied XRPC operation to run against a stewarded account. */
export interface ProxyOperation {
  /** The inner XRPC method NSID (e.g. `com.atproto.repo.getRecord`). */
  nsid: string;
  /** HTTP method for the inner request. */
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Optional query parameters for the inner request. */
  parameters?: Record<string, unknown>;
  /** Optional JSON body for the inner request. */
  body?: Record<string, unknown>;
  /**
   * Optional raw-bytes body (e.g. a blob upload). When set, `body` is
   * ignored and the bytes are carried in the envelope as the AT Protocol
   * binary marker `{ "$bytes": <base64> }`, with `encoding` as the inner
   * request's content-type.
   */
  bytes?: Uint8Array;
  /**
   * Optional content-type (encoding) for the inner request body (e.g.
   * `image/png`). Defaults to `application/json` for JSON bodies; for a raw
   * bytes body it is required to convey the MIME type.
   */
  encoding?: string;
}

/** The `did#service` fragment for a steward's PDS. */
const AT_PROTO_PDS_FRAGMENT = "atproto_pds";
/** The arbiter service record collection + rkey on a stewarded account. */
const SERVICE_COLLECTION = "town.muni.arbiter.service";
const SERVICE_RKEY = "self";

/** serviceAuth token lifetime, passed as `exp` (seconds). */
const TOKEN_LIFETIME_SEC = 300;

/** A resolved arbiter target for a given stewarded account. */
export interface ResolvedArbiter {
  /** The arbiter server's DID (the serviceAuth `aud`). */
  did: string;
  /** The arbiter server's base HTTP origin (for /xrpc/... calls). */
  url: string;
}

/**
 * Convert an arbiter server's `did:web` into an `https://` origin.
 *
 * `did:web:arbiter.example.com` → `https://arbiter.example.com`.
 * Ports are percent-encoded in the DID per the did:web spec
 * (`did:web:localhost%3A8203` → `http://localhost:8203`); localhost uses http.
 *
 * TODO: this assumes the origin lives at the DID's host. Long-term we should
 * resolve the DID document and read its `#arbiter` service endpoint instead.
 */
function arbiterUrlFromDid(arbiterDid: string): string {
  if (!arbiterDid.startsWith("did:web:")) {
    throw new Error(`Unsupported arbiter DID method: ${arbiterDid}`);
  }
  const host = decodeURIComponent(arbiterDid.slice("did:web:".length));
  const scheme = host.startsWith("localhost") ? "http" : "https";
  return `${scheme}://${host}`;
}

/** Base64-encode bytes for the `$bytes` binary marker (standard padded). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class ArbiterClient {
  readonly #agent: Agent;

  constructor(agent: Agent) {
    this.#agent = agent;
  }

  /**
   * Resolve the arbiter for a stewarded account: read its
   * `town.muni.arbiter.service/self` record, then derive the server's HTTP
   * origin from the recorded arbiter DID. Throws when the space has no
   * arbiter.
   */
  async resolveArbiter(spaceDid: string): Promise<ResolvedArbiter> {
    const resp = await this.#agent.com.atproto.repo.getRecord(
      {
        repo: spaceDid,
        collection: SERVICE_COLLECTION,
        rkey: SERVICE_RKEY,
      },
      {
        headers: {
          "atproto-proxy": `${spaceDid}#${AT_PROTO_PDS_FRAGMENT}`,
        },
      },
    );
    const value = resp.data.value as { did?: unknown };
    if (typeof value?.did !== "string") {
      throw new Error(
        `Space ${spaceDid} has no town.muni.arbiter.service record`,
      );
    }
    return { did: value.did, url: arbiterUrlFromDid(value.did) };
  }

  /**
   * Mint a fresh serviceAuth token scoped to the given arbiter server DID +
   * the `town.muni.arbiter.proxy` method.
   *
   * A new token is minted for every request: the arbiter enforces single-use
   * (replay protection on the token `jti`), so a token must never be sent
   * twice, even within its validity window.
   */
  async #getProxyToken(arbiterDid: string): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SEC;
    const resp = await this.#agent.com.atproto.server.getServiceAuth({
      aud: arbiterDid,
      lxm: "town.muni.arbiter.proxy",
      exp,
    });
    return resp.data.token;
  }

  /**
   * Run an XRPC operation against a stewarded account's PDS, proxied through
   * the space's arbiter's `town.muni.arbiter.proxy` procedure. Returns the
   * body of the inner XRPC response (or throws if the operation or its proxy
   * fails).
   */
  async proxy(spaceDid: string, op: ProxyOperation): Promise<Record<string, unknown>> {
    const arbiter = await this.resolveArbiter(spaceDid);
    const token = await this.#getProxyToken(arbiter.did);
    const res = await fetch(
      `${arbiter.url}/xrpc/town.muni.arbiter.proxy`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          arbiterDid: spaceDid,
          target: `${spaceDid}#${AT_PROTO_PDS_FRAGMENT}`,
          method: op.method,
          nsid: op.nsid,
          ...(op.parameters ? { parameters: op.parameters } : {}),
          // A raw-bytes body is carried as the AT Protocol binary marker
          // `{ $bytes: <base64> }`; the arbiter decodes it back to bytes and
          // sends it with `encoding` as the inner request's content-type.
          body: op.bytes
            ? { $bytes: bytesToBase64(op.bytes) }
            : op.body,
          encoding: op.encoding,
        }),
      },
    );
    if (!res.ok) {
      // The arbiter relays the upstream XRPC error verbatim (see leaf-0.4
      // `xrpc_result_to_response` / `AppError::into_response`). The `error`
      // field may be a string name (`{ $type, error: "<name>" }`) or an object
      // `{ error, message }` — parse both so the detail is surfaced.
      let errorName: string | null = null;
      let errorMessage: string | null = null;
      try {
        const body = (await res.json()) as { error?: unknown; message?: unknown };
        if (typeof body?.error === "string") {
          errorName = body.error;
        } else if (body?.error && typeof body.error === "object") {
          const obj = body.error as Record<string, unknown>;
          if (typeof obj.error === "string") errorName = obj.error;
          if (typeof obj.message === "string") errorMessage = obj.message;
        }
        if (!errorMessage && typeof body?.message === "string") {
          errorMessage = body.message;
        }
      } catch {
        // Non-JSON error body; fall through with no error detail.
      }
      const detail = errorMessage ? `: ${errorMessage}` : "";
      throw new ArbiterProxyError(
        res.status,
        `Arbiter proxy failed (${res.status}) for ${op.nsid}${detail}`,
        errorName,
      );
    }
    // Success. Some proxied procedures (e.g. com.atproto.identity.updateHandle)
    // are void and return 200 with an empty body — don't try to parse JSON.
    if (res.status === 204) return {};
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

}
