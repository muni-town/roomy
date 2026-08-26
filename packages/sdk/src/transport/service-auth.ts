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
import { withRateLimitRetry } from "./retry";
import { XrpcTimeoutError } from "./errors";

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

/**
 * Requested token lifetime in seconds. Passed as the `exp` parameter to
 * `com.atproto.server.getServiceAuth`. The PDS may enforce its own maximum,
 * but 300 seconds (5 minutes) is well within typical bounds.
 */
const REQUESTED_TOKEN_LIFETIME_SEC = 300;

/**
 * Hard deadline for a single PDS token round-trip. A slow or wedged PDS
 * must never hold up an XRPC call indefinitely — without this, a send
 * whose token is expired (or whose PDS is unreachable) hangs forever on
 * `getServiceAuth` and the request never leaves the client.
 */
const TOKEN_TIMEOUT_MS = 10_000;

/**
 * Extra attempts (beyond the first) when the PDS rate-limits the token
 * fetch. The PDS is a third-party hop; a transient 429 there should not
 * fail a send that the appserver would have accepted.
 */
const TOKEN_MAX_RETRIES = 2;

/**
 */
export interface ServiceAuthClientOptions {
  /** Per-attempt deadline for a PDS token round-trip, in ms (default 10_000). */
  timeoutMs?: number;
  /** Extra attempts beyond the first when the PDS rate-limits (default 2). */
  maxRetries?: number;
}

export class ServiceAuthClient {
  readonly #agent: Agent;
  readonly #cache = new Map<string, CachedToken>();
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(agent: Agent, opts: ServiceAuthClientOptions = {}) {
    this.#agent = agent;
    this.#timeoutMs = opts.timeoutMs ?? TOKEN_TIMEOUT_MS;
    this.#maxRetries = opts.maxRetries ?? TOKEN_MAX_RETRIES;
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

    const exp = Math.floor(Date.now() / 1000) + REQUESTED_TOKEN_LIFETIME_SEC;
    const token = await withRateLimitRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        // Hard deadline: races the PDS round-trip so a transport that ignores
        // the abort signal still cannot hang the caller.
        let timedOut = false;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          deadlineTimer = setTimeout(() => {
            timedOut = true;
            reject(
              new XrpcTimeoutError(
                lxm ?? "com.atproto.server.getServiceAuth",
                this.#timeoutMs,
              ),
            );
          }, this.#timeoutMs);
        });
        deadline.catch(() => {});
        try {
          return await Promise.race([
            this.#agent.com.atproto.server
              .getServiceAuth(
                {
                  aud,
                  exp,
                  ...(lxm !== undefined ? { lxm } : {}),
                },
                { signal: controller.signal },
              )
              .then((resp) => resp.data.token),
            deadline,
          ]);
        } catch (err) {
          // The deadline fired: attribute the failure to the timeout —
          // the PDS never answered in time, whatever error the agent wrapped
          // the abort as. Quick non-abort errors (e.g. a 401) pass through
          // untouched so session-recovery logic still sees them.
          if (timedOut) {
            throw new XrpcTimeoutError(
              lxm ?? "com.atproto.server.getServiceAuth",
              this.#timeoutMs,
            );
          }
          throw err;
        } finally {
          clearTimeout(timer);
          clearTimeout(deadlineTimer);
        }
      },
      { maxRetries: this.#maxRetries },
    );

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
