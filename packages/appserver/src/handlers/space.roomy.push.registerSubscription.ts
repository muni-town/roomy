/**
 * XRPC: space.roomy.push.registerSubscription (procedure).
 *
 * Stores a browser PushSubscription for the caller, keyed by
 * `(userDid, endpoint)`. Idempotent on endpoint: re-registering the same
 * endpoint updates its keys/expiry rather than duplicating. Authenticated
 * via the existing PDS-proxy inter-service JWT path (`parseUserDid`), identical
 * to `updateSeen` / `joinSpace`.
 */

import { openDb } from "../db/db.ts";
import { upsertSubscription } from "../queries/pushSubscriptions.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface RegisterSubscriptionBody {
  endpoint?: unknown;
  keys?: unknown;
  expirationTime?: unknown;
}

export const registerSubscriptionHandler: ProcedureHandler<
  RegisterSubscriptionBody,
  void
> = async (_params: QueryParams, auth: AuthCtx, body: RegisterSubscriptionBody) => {
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

  const keys = body.keys;
  if (
    typeof keys !== "object" ||
    keys === null ||
    typeof (keys as Record<string, unknown>).p256dh !== "string" ||
    (keys as Record<string, unknown>).p256dh === "" ||
    typeof (keys as Record<string, unknown>).auth !== "string" ||
    (keys as Record<string, unknown>).auth === ""
  ) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'keys' must be an object with non-empty 'p256dh' and 'auth' strings",
    );
  }

  const expirationTimeRaw = body.expirationTime;
  if (
    expirationTimeRaw !== undefined &&
    expirationTimeRaw !== null &&
    typeof expirationTimeRaw !== "number"
  ) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'expirationTime' must be a number if provided",
    );
  }

  const db = openDb();
  upsertSubscription(db, {
    userDid,
    endpoint: body.endpoint,
    p256dh: (keys as { p256dh: string }).p256dh,
    auth: (keys as { auth: string }).auth,
    expirationTime:
      typeof expirationTimeRaw === "number" ? expirationTimeRaw : null,
  });
};