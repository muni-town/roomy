/**
 * Arbiter client — the appserver's outbound calls to the arbiter server.
 *
 * The arbiter (leaf-0.4) provisions real ATProto accounts for new Roomy
 * spaces. The appserver authenticates to it with a self-signed serviceAuth
 * JWT (Phase 0) and calls:
 *
 * - `town.muni.arbiter.createArbiter` — provision a new stewarded account,
 *   returns `{ did }`. No policy is written: the account stays offline
 *   (fail-closed) until configured.
 * - `town.muni.arbiter.resetConfig` — bootstrap/replace the account's
 *   `town.muni.arbiter.config/self` record (recovery-admin-only hatch; the
 *   appserver is the recovery admin, so it may do this). Performs no policy
 *   evaluation, so it works while the arbiter is offline.
 * - `town.muni.arbiter.proxy` — drive the policy pipeline over an inner XRPC
 *   request, proxying it to the steward's PDS as the stewarded account.
 */

import { mintServiceAuth } from "../auth/serviceAuth.ts";
import type { ArbiterConfig } from "./config.ts";

/** Error thrown when the arbiter rejects a request. */
export class ArbiterError extends Error {
  readonly status: number;
  readonly error?: string;
  constructor(status: number, message: string, error?: string) {
    super(message);
    this.name = "ArbiterError";
    this.status = status;
    this.error = error;
  }
}

interface ArbiterResponse {
  status: number;
  json: unknown;
}

/**
 * Hard timeout for a single arbiter request. A hung arbiter must not block
 * `createSpace` indefinitely — the space provision call sits in the request
 * path. Mirrors the appserver's other outbound timeouts (embed sweeper).
 */
const ARBITER_TIMEOUT_MS = 10000;

async function arbiterFetch(
  config: ArbiterConfig,
  ownDid: string,
  nsid: string,
  body?: unknown,
): Promise<ArbiterResponse> {
  const token = await mintServiceAuth(config.did, nsid, ownDid);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ARBITER_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${config.url}/xrpc/${nsid}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  const text = await resp.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!resp.ok) {
    let message = `arbiter ${nsid} failed (${resp.status})`;
    let error: string | undefined;
    if (json && typeof json === "object" && "message" in json && typeof json.message === "string") {
      message = json.message;
    }
    if (json && typeof json === "object" && "error" in json && typeof json.error === "string") {
      error = json.error;
    }
    throw new ArbiterError(resp.status, message, error);
  }
  return { status: resp.status, json };
}

/**
 * Provision a new stewarded account via `town.muni.arbiter.createArbiter`.
 *
 * The arbiter creates a real account on the Roomy PDS and returns its DID.
 * The account is fail-closed until a config is bootstrapped via `resetConfig`.
 */
export async function createArbiter(
  config: ArbiterConfig,
  ownDid: string,
): Promise<string> {
  const { json } = await arbiterFetch(config, ownDid, "town.muni.arbiter.createArbiter");
  if (json && typeof json === "object" && "did" in json && typeof json.did === "string") {
    return json.did;
  }
  throw new ArbiterError(200, "arbiter createArbiter returned no `did`");
}

/**
 * Bootstrap or wholesale-replace a stewarded account's configuration via
 * `town.muni.arbiter.resetConfig`. Only the recovery admin (the appserver)
 * may call it. The request performs no policy evaluation, so it works while
 * the arbiter is offline — exactly the state of a freshly-provisioned
 * account (`createArbiter` writes no config). The arbiter writes the
 * `town.muni.arbiter.config/self` record verbatim (CAS putRecord) and
 * re-onboards.
 */
export async function resetConfig(
  config: ArbiterConfig,
  ownDid: string,
  arbiterDid: string,
  reference: { trustedScopes: string[]; policyLayers: string[] },
): Promise<void> {
  await arbiterFetch(config, ownDid, "town.muni.arbiter.resetConfig", {
    arbiterDid,
    trustedScopes: reference.trustedScopes,
    policyLayers: reference.policyLayers,
  });
}

/**
 * Proxy an inner XRPC request through the arbiter's policy via
 * `town.muni.arbiter.proxy`. The policy decides whether the request is
 * proxied to the steward's PDS as the stewarded account.
 */
export async function proxy(
  config: ArbiterConfig,
  ownDid: string,
  arbiterDid: string,
  target: string,
  method: string,
  nsid: string,
  parameters?: unknown,
  body?: unknown,
): Promise<unknown> {
  const { json } = await arbiterFetch(config, ownDid, "town.muni.arbiter.proxy", {
    arbiterDid,
    target,
    method,
    nsid,
    parameters,
    body,
  });
  return json;
}
