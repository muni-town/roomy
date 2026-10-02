/**
 * Resolving a space *reference* from a URL to the DID the XRPC params expect.
 *
 * A space is identified by its DID (`did:plc:…` / `did:web:…`), but the links
 * people actually share carry a **handle** — `roomy.space/join?space=home`,
 * `roomy.space/join?space=atmosphereconf.org`. Handing that straight to
 * `getMetadata` produces `404 Space not found: home`: a lookup phrased as if
 * the space were missing, for a value the appserver was never able to answer
 * (`134` such lines in 4 days). A URL-supplied reference must therefore be
 * resolved before any id-expecting request is issued.
 *
 * **Which resolver.** Space handles are not ATProto account handles. An
 * ATProto handle resolves through `_atproto.<domain>` TXT / `/.well-known` to
 * the *account's* DID, and a space's stewarded account is not the space: for
 * `atmosphereconf.org` the ATProto answer is `did:plc:3xewinw4wtimo2lqfy5fm5sw`
 * (the conference's own account — no such space), while the space is published
 * under the Leaf record `_leaf.atmosphereconf.org` → `did:plc:ik6zkolq2vtq77lxsi65dcfq`.
 * The resolver that answers for space handles is therefore the Leaf resolver
 * (`town.muni.leaf.resolveHandle`), the same one the space handle settings page
 * already verifies handles against. It is reachable from the browser with no
 * new infrastructure (`access-control-allow-origin: *`, verified).
 *
 * **What is not attempted.** A reference that is not an ATProto handle shape —
 * a bare word like `home`, a route name, or a stringified object — names no
 * domain to look up, so it is reported as not found without a request rather
 * than sent to a resolver that can only fail on it.
 */

import { Did, Handle, type } from "@roomy-space/sdk";

/**
 * The Leaf resolver's handle lookup — the authority for space handles. Shared
 * with the space handle settings page so both read handles the same way.
 */
export const SPACE_HANDLE_RESOLVER_URL =
  "https://resolver.roomy.chat/xrpc/town.muni.leaf.resolveHandle";

/** Whether `value` is already a space id (a DID), needing no resolution. */
export function isSpaceId(value: string): value is Did {
  return !(Did(value) instanceof type.errors);
}

/** Whether `value` is shaped like an ATProto handle, i.e. resolvable at all. */
export function isResolvableHandle(value: string): value is Handle {
  return !(Handle(value) instanceof type.errors);
}

/**
 * Resolve a space handle to the space's DID, or `null` when the resolver has
 * no such handle (unknown handle, or the domain publishes no Leaf record).
 *
 * A resolver that answers with a non-200 carries a `{status, error}` body and
 * no `did`; both that and a transport failure mean "no space for this handle".
 */
export async function resolveSpaceHandle(
  handle: string,
): Promise<string | null> {
  const url = new URL(SPACE_HANDLE_RESOLVER_URL);
  url.searchParams.set("handle", handle);

  let payload: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  const did = (payload as { did?: unknown } | null)?.did;
  // Only a DID is usable as a `spaceId`; a resolver that answers with anything
  // else is not something to send onward.
  return typeof did === "string" && isSpaceId(did) ? did : null;
}

/**
 * The space id a URL reference names: the reference itself when it is already
 * a DID, its resolved DID when it is a handle, and `null` when it names no
 * resolvable space (including values that are not handle-shaped at all, which
 * are rejected without a network call).
 */
export async function resolveSpaceRef(ref: string): Promise<string | null> {
  if (isSpaceId(ref)) return ref;
  if (!isResolvableHandle(ref)) return null;
  return resolveSpaceHandle(ref);
}
