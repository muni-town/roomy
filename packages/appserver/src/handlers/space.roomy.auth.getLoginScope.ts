/**
 * XRPC: space.roomy.auth.getLoginScope (query).
 *
 * UNAUTHENTICATED. Resolves a handle to a DID and returns the raw OAuth scope
 * string that user last consented to, or null when no grant is stored.
 *
 * Why anonymous: the client calls this *before* it has a token — the whole
 * point is to decide which scope to request at login, and the stored scope is
 * what lets a returning user get max access back in one round-trip with no
 * re-prompting. That is a chicken-and-egg (a token is needed to call
 * authenticated endpoints, but the scope is needed to get a token), so the
 * appserver breaks it by resolving handle→DID server-side. The stored scope is
 * not sensitive — it is a list of public permission token strings that are
 * already declared in the client metadata.
 *
 * Because it resolves an attacker-chosen handle against DNS/HTTP without
 * requiring a token, the router applies a tighter per-endpoint rate limit
 * (see `ENDPOINT_RATE_LIMITS` in `xrpc/rateLimit.ts`).
 *
 * The `did` in the response saves the client a separate resolution call.
 */

import { openReadStateDb } from "../db/db.ts";
import { selectGrantedScope } from "../queries/userOauthGrants.ts";
import { idResolver } from "../identity.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface GetLoginScopeResult {
  did: string;
  scope: string | null;
}

export const getLoginScopeHandler: QueryHandler<
  QueryParams,
  GetLoginScopeResult
> = async (params: QueryParams, _auth: AuthCtx) => {
  const handle = requireString(params, "handle");

  // Resolve handle → DID with the appserver's shared resolver (the same
  // instance JWT verification uses), so the in-memory DID/handle caches are
  // shared rather than duplicated.
  let did: string | undefined;
  try {
    did = await idResolver.handle.resolve(handle);
  } catch {
    did = undefined;
  }
  if (!did) {
    throw new XrpcError(404, "NotFound", `Could not resolve handle: ${handle}`);
  }

  const scope = await selectGrantedScope(openReadStateDb(), did);

  return { did, scope };
};
