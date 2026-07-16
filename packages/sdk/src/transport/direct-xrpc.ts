/**
 * DirectXrpcClient — typed XRPC client that makes direct HTTP requests to
 * the appserver using service auth tokens.
 *
 * Unlike the proxied `agentQuery`/`agentProcedure` wrappers (which route
 * through the PDS via `atproto-proxy`), this client:
 *
 *  1. Resolves the appserver's HTTP origin from its DID document.
 *  2. Obtains a short-lived service auth JWT via `ServiceAuthClient`.
 *  3. Sends the request directly to the appserver with `Authorization: Bearer <token>`.
 *
 * Token caching and auto-refresh are handled transparently by the
 * `ServiceAuthClient` — callers never need to think about token lifecycle.
 *
 * Usage:
 * ```ts
 * const auth = new ServiceAuthClient(agent);
 * const xrpc = new DirectXrpcClient(appserverUrl, appserverDid, auth);
 * const spaces = await xrpc.query("space.roomy.space.getSpaces", {});
 * ```
 */

import { type } from "arktype";
import {
  QUERY_SCHEMAS,
  PROCEDURE_SCHEMAS,
  type QueryNsid,
  type QueryParams,
  type QueryResponse,
  type ProcedureNsid,
  type ProcedureInput,
  type ProcedureOutput,
} from "./registry";
import { XrpcResponseValidationError, RateLimitError } from "./errors";
import { withRateLimitRetry, type RateLimitRetryOptions } from "./retry";
import { ServiceAuthClient } from "./service-auth";

export class DirectXrpcClient {
  readonly #appserverUrl: string;
  readonly #appserverDid: string;
  readonly #serviceAuth: ServiceAuthClient;
  /**
   * Retry/backoff policy applied on HTTP 429. Overridable per-instance so
   * tests can inject a synchronous sleep and callers can tune limits.
   */
  #retryOpts: RateLimitRetryOptions = {};

  constructor(
    appserverUrl: string,
    appserverDid: string,
    serviceAuth: ServiceAuthClient,
  ) {
    // Strip trailing slash so callers can safely append paths like /xrpc/...
    this.#appserverUrl = appserverUrl.replace(/\/+$/, "");
    this.#appserverDid = appserverDid;
    this.#serviceAuth = serviceAuth;
  }

  /**
   * Override the rate-limit retry/backoff policy for this client.
   * Pass `{}` to use defaults (max 4 retries, 1s→30s jittered backoff).
   */
  setRateLimitRetry(opts: RateLimitRetryOptions): this {
    this.#retryOpts = opts;
    return this;
  }

  /**
   * Execute a typed XRPC query (GET) against the appserver.
   *
   * Automatically obtains a service auth token, makes the HTTP request,
   * and validates the response against the registered arktype schema.
   */
  async query<N extends QueryNsid>(
    nsid: N,
    params: QueryParams<N>,
  ): Promise<QueryResponse<N>> {
    const entry = QUERY_SCHEMAS[nsid];
    const stringParams = stringifyParams(params as Record<string, unknown>);

    return withRateLimitRetry(async () => {
      const token = await this.#serviceAuth.getToken(this.#appserverDid, nsid);

      const url = new URL(`${this.#appserverUrl}/xrpc/${nsid}`);
      for (const [k, v] of Object.entries(stringParams)) {
        url.searchParams.set(k, v);
      }

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        throw await toXrpcError(resp, nsid);
      }

      const data = await resp.json();
      const parsed = entry.response(data);
      if (parsed instanceof type.errors) {
        throw new XrpcResponseValidationError(nsid, parsed);
      }
      return parsed as QueryResponse<N>;
    }, this.#retryOpts);
  }

  /**
   * Execute a typed XRPC procedure (POST) against the appserver.
   *
   * Automatically obtains a service auth token, makes the HTTP request,
   * and validates the response against the registered arktype schema.
   *
   * Void procedures (no outputSchema) return `{}` when the server responds
   * with an empty body.
   */
  async procedure<N extends ProcedureNsid>(
    nsid: N,
    input: ProcedureInput<N>,
  ): Promise<ProcedureOutput<N>> {
    const entry = PROCEDURE_SCHEMAS[nsid];

    return withRateLimitRetry(async () => {
      const token = await this.#serviceAuth.getToken(this.#appserverDid, nsid);

      const url = `${this.#appserverUrl}/xrpc/${nsid}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
      });

      if (!resp.ok) {
        throw await toXrpcError(resp, nsid);
      }

      // Void short-circuit: no outputSchema means void return.
      // The appserver returns 200 with no body for void procedures.
      // Read as text first so we can reliably detect an empty body
      // regardless of Content-Length / Transfer-Encoding headers (which
      // may be stripped by reverse proxies in production).
      const bodyText = await resp.text();
      const data = bodyText.length === 0 ? {} : JSON.parse(bodyText);

      const parsed = entry.output(data);
      if (parsed instanceof type.errors) {
        throw new XrpcResponseValidationError(nsid, parsed);
      }
      return parsed as ProcedureOutput<N>;
    }, this.#retryOpts);
  }

  /** The appserver DID this client is configured to talk to. */
  get appserverDid(): string {
    return this.#appserverDid;
  }

  /** The appserver HTTP origin this client is configured to talk to. */
  get appserverUrl(): string {
    return this.#appserverUrl;
  }
  /**
   * Execute an untyped XRPC call (query or procedure) against the appserver.
   *
   * Unlike `query`/`procedure`, this method does not validate the response
   * against a registered arktype schema. Use it for admin/internal NSIDs
   * that have no schema entry in the registry.
   *
   * - GET for queries, POST for procedures (determined by `method`).
   * - Returns the parsed JSON body as `unknown`.
   */
  async call(
    nsid: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<{ data: unknown }> {
    return withRateLimitRetry(async () => {
      const token = await this.#serviceAuth.getToken(this.#appserverDid, nsid);

      if (body !== undefined) {
        // Procedure (POST)
        const url = `${this.#appserverUrl}/xrpc/${nsid}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          throw await toXrpcError(resp, nsid);
        }
        const text = await resp.text();
        return { data: text.length === 0 ? {} : JSON.parse(text) };
      }

      // Query (GET)
      const url = new URL(`${this.#appserverUrl}/xrpc/${nsid}`);
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (!resp.ok) {
        throw await toXrpcError(resp, nsid);
      }
      return { data: await resp.json() };
    }, this.#retryOpts);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function stringifyParams(
  params: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

async function toXrpcError(resp: Response, nsid: string): Promise<Error> {
  // 429: surface as a RateLimitError so the transport's retry wrapper can
  // read the Retry-After header and back off. The appserver's rate limiter
  // (and any reverse proxy) sets Retry-After in seconds; absent it, the
  // wrapper falls back to exponential jitter.
  if (resp.status === 429) {
    const retryAfterHdr = resp.headers.get("retry-after");
    const retryAfterSec =
      retryAfterHdr != null && /^\d+$/.test(retryAfterHdr)
        ? Number(retryAfterHdr)
        : null;
    const err = new RateLimitError(retryAfterSec);
    Object.assign(err, { nsid, errorType: "RateLimitExceeded" });
    return err;
  }

  let body: string;
  try {
    body = await resp.text();
  } catch {
    body = "(unable to read response body)";
  }

  let errorMessage: string;
  let errorType: string | undefined;
  try {
    const json = JSON.parse(body);
    errorMessage = json.message ?? body;
    errorType = json.error;
  } catch {
    errorMessage = body;
  }

  const msg = `XRPC ${nsid} failed (${resp.status}): ${errorMessage}`;
  const err = new Error(msg);
  Object.assign(err, { status: resp.status, errorType, nsid });
  return err;
}
