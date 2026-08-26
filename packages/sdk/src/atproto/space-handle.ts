import type { ArbiterClient } from "./arbiter";
import { resolvePdsEndpoint } from "../transport/did-resolve";

/**
 * Helpers for reading and setting a space's handle on its stewarded account.
 *
 * Reading the available handle domains is public PDS config: it must be
 * answered by the space's own PDS (not the caller's), so we resolve the
 * space's `#atproto_pds` endpoint and query it directly. Setting the handle
 * mutates the space's stewarded account, which only the arbiter can do — so it
 * goes through the arbiter's `proxy` procedure, whose Rego policy grants Roomy
 * space admins the ability to act under the space's account.
 */

/**
 * The available handle suffixes on the space's stewarded PDS, from
 * `com.atproto.server.describeServer`. A handle must end with one of these.
 *
 * Resolved from the space's `#atproto_pds` endpoint directly (public data, no
 * auth) rather than through the caller's PDS proxy, because `describeServer`
 * is answered by whichever PDS the session points at — using the agent proxy
 * would return the wrong domains.
 */
export async function getSpaceHandleDomains(
  spaceDid: string,
): Promise<string[]> {
  const body = await pdsQuery(spaceDid, "com.atproto.server.describeServer");
  const domains = body.availableUserDomains;
  if (!Array.isArray(domains)) {
    throw new Error(`describeServer returned no availableUserDomains`);
  }
  return domains.filter((d): d is string => typeof d === "string");
}

/**
 * The space's current handle on its stewarded PDS, from
 * `com.atproto.repo.describeRepo` (public read, no auth). Returns `null` when
 * the account has no handle set yet.
 */
export async function getSpaceHandle(
  spaceDid: string,
): Promise<string | null> {
  const body = await pdsQuery(spaceDid, "com.atproto.repo.describeRepo", {
    repo: spaceDid,
  });
  const handle = body.handle;
  return typeof handle === "string" && handle ? handle : null;
}

/** Query the space's own PDS XRPC endpoint (public, no auth). */
async function pdsQuery(
  spaceDid: string,
  nsid: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const pds = await resolvePdsEndpoint(spaceDid);
  const url = new URL(`${pds}/xrpc/${nsid}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${nsid} failed on ${pds}: ${res.status}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * Set the space's handle on its stewarded account via the arbiter proxy.
 *
 * The PDS validates the handle against its own configured domain suffixes and
 * availability. An error such as `HandleNotAvailable` (already taken),
 * `InvalidHandle`, `UnsupportedDomain`, or `InvalidPassword` is surfaced as an
 * `ArbiterProxyError` from the SDK.
 */
export async function setSpaceHandle(
  arbiter: ArbiterClient,
  spaceDid: string,
  handle: string,
): Promise<void> {
  await arbiter.proxy(spaceDid, {
    nsid: "com.atproto.identity.updateHandle",
    method: "POST",
    body: { handle },
  });
}
