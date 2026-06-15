/**
 * ServiceAuthClient — caches and auto-refreshes ATProto service auth tokens.
 *
 * Wraps an `Agent` and calls `com.atproto.server.getServiceAuth` to obtain
 * short-lived JWTs that can be used to authenticate directly to a service
 * (e.g. the Roomy appserver) without proxying through the PDS.
 *
 * Tokens are cached by `aud:lxm` key. Before returning a cached token the
 * client checks whether it is still valid (with a 30-second safety margin)
 * and fetches a fresh one if not.
 *
 * Usage:
 * ```ts
 * const auth = new ServiceAuthClient(agent);
 * const token = await auth.getToken("did:web:appserver.roomy.chat");
 * // Use token as Authorization: Bearer <token>
 * ```
 */

import type { Agent } from "@atproto/api";

export interface CachedToken {
  token: string;
  expiresAt: number; // Unix epoch seconds
}

/**
 * Safety margin: if a token expires within this many seconds, treat it as
 * expired and fetch a new one. This prevents race conditions where a token
 * expires between the check and the actual request.
 */
const EXPIRY_MARGIN_SEC = 30;

export class ServiceAuthClient {
  readonly #agent: Agent;
  readonly #cache = new Map<string, CachedToken>();

  constructor(agent: Agent) {
    this.#agent = agent;
  }

  /**
   * Get a valid service auth token for the given audience and optional
   * lexicon method. Returns a cached token if one exists and is not near
   * expiry; otherwise fetches a fresh one from the PDS.
   *
   * @param aud - The DID of the service to authenticate to (e.g. the appserver DID)
   * @param lxm - Optional lexicon (XRPC) method to bind the token to.
   *              If omitted, the token is valid for all methods.
   * @returns A valid Bearer token string
   */
  async getToken(aud: string, lxm?: string): Promise<string> {
    const key = lxm ? `${aud}:${lxm}` : aud;
    const cached = this.#cache.get(key);

    if (cached && Date.now() / 1000 < cached.expiresAt - EXPIRY_MARGIN_SEC) {
      return cached.token;
    }

    const resp = await this.#agent.com.atproto.server.getServiceAuth({
      aud,
      ...(lxm !== undefined ? { lxm } : {}),
    });

    const token = resp.data.token;
    const expiresAt = this.#decodeExpiry(token);

    this.#cache.set(key, { token, expiresAt });
    return token;
  }

  /**
   * Clear all cached tokens. Useful on logout or session change.
   */
  clear(): void {
    this.#cache.clear();
  }

  /**
   * Decode the JWT payload to extract the `exp` claim.
   * Throws if the token is malformed.
   */
  #decodeExpiry(token: string): number {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Service auth token is not a valid JWT");
    }
    try {
      const payload = JSON.parse(atob(parts[1]!));
      if (typeof payload.exp !== "number") {
        throw new Error("JWT payload missing exp claim");
      }
      return payload.exp;
    } catch (err) {
      throw new Error(
        `Failed to decode service auth JWT payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
