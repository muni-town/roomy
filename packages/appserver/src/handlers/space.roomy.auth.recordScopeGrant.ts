/**
 * XRPC: space.roomy.auth.recordScopeGrant (procedure).
 *
 * Authenticated. Upserts the caller's OAuth scope grant — the RAW scope
 * string the PDS actually returned from `OAuthSession.getTokenInfo()`, never a
 * tier name. Tiers (`semble`, `withDms`) are a client-side UX abstraction; the
 * server stores an opaque string so consent narrowing and future tiers need no
 * schema change.
 *
 * LAST-GRANTED, not a high-water mark. The client calls this after every
 * login/expansion, so the stored value tracks the most recent consent. If a
 * user narrows their consent on the PDS consent screen, the stored value
 * narrows too and they are not silently re-granted the removed scopes on next
 * login (Phase 4 lets the user revoke from app settings, which relies on
 * exactly this).
 *
 * Fire-and-forget on the client: a failure is non-fatal (the session works
 * regardless) and self-heals on the next login.
 */

import { openReadStateDb } from "../db/db.ts";
import { upsertGrantedScope } from "../queries/userOauthGrants.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface RecordScopeGrantBody {
  scope?: unknown;
}

export const recordScopeGrantHandler: ProcedureHandler<
  RecordScopeGrantBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: RecordScopeGrantBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  if (typeof body.scope !== "string" || body.scope === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: scope",
    );
  }

  await upsertGrantedScope(openReadStateDb(), userDid, body.scope);
};
