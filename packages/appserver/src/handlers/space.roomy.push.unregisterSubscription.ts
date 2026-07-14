/**
 * XRPC: space.roomy.push.unregisterSubscription (procedure).
 *
 * Removes a stored PushSubscription by endpoint. Called on explicit
 * unsubscribe / logout. Idempotent: unregistering an unknown endpoint is not
 * an error. Authenticated via `parseUserDid` like the other push procedures.
 */

import { openDb } from "../db/db.ts";
import { deleteSubscription } from "../queries/pushSubscriptions.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface UnregisterSubscriptionBody {
  endpoint?: unknown;
}

export const unregisterSubscriptionHandler: ProcedureHandler<
  UnregisterSubscriptionBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: UnregisterSubscriptionBody) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  if (typeof body.endpoint !== "string" || body.endpoint === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: endpoint",
    );
  }

  const db = openDb();
  await deleteSubscription(db, userDid, body.endpoint);
};
