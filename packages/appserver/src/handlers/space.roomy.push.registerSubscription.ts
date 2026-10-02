/**
 * XRPC: space.roomy.push.registerSubscription (procedure).
 *
 * Stores a device's push destination for the caller, keyed by
 * `(userDid, endpoint)`. Idempotent on endpoint: re-registering the same
 * destination updates its fields rather than duplicating. Authenticated via
 * the existing PDS-proxy inter-service JWT path (`parseUserDid`), identical
 * to `updateSeen` / `joinSpace`.
 *
 * `kind` names the transport that can reach the device and defaults to
 * `webpush`, so a browser client that predates the field keeps working. The
 * two kinds of destination need different fields, and the pairing is checked
 * here rather than in the schema (which is one flat object so the wire
 * contract stays expressible as an atproto lexicon):
 *
 *  - `webpush` registers a browser `PushSubscription`: a push-service URL plus
 *    the RFC 8291 `p256dh`/`auth` keypair, which delivery cannot proceed
 *    without, so an absent pair is a bad request rather than a stored row that
 *    can never be delivered to.
 *  - `apns`/`fcm` register a platform device token in `endpoint` and carry no
 *    keys. Keys sent alongside one are dropped rather than stored, so a row's
 *    columns describe exactly one transport.
 *
 * An unknown `kind` is rejected: it would be stored and then counted as a
 * failure by the dispatcher on every delivery, which hides a typo behind a
 * runtime symptom instead of reporting it at registration.
 */

import { openReadStateDb } from "../db/db.ts";
import { upsertSubscription } from "../queries/pushSubscriptions.ts";
import {
  PUSH_TRANSPORT_KINDS,
  isPushTransportKind,
} from "../push/transports/types.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface RegisterSubscriptionBody {
  endpoint?: unknown;
  kind?: unknown;
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

  // Defaults to `webpush` so a browser client that predates the field keeps
  // registering a push-service URL exactly as it did before.
  const kind = body.kind ?? "webpush";
  if (!isPushTransportKind(kind)) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Field 'kind' must be one of: ${PUSH_TRANSPORT_KINDS.join(", ")}`,
    );
  }

  let p256dh: string | undefined;
  let authKey: string | undefined;
  if (kind === "webpush") {
    if (typeof body.keys !== "object" || body.keys === null) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Field 'keys' is required for kind 'webpush' and must be an object with non-empty 'p256dh' and 'auth' strings",
      );
    }
    // `keys` is narrowed to a non-null object; read its fields via a named
    // handle rather than an inline cast on each access.
    const keys = body.keys as Record<string, unknown>;
    if (
      typeof keys.p256dh !== "string" ||
      keys.p256dh === "" ||
      typeof keys.auth !== "string" ||
      keys.auth === ""
    ) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        "Field 'keys' must be an object with non-empty 'p256dh' and 'auth' strings",
      );
    }
    p256dh = keys.p256dh;
    authKey = keys.auth;
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

  const db = openReadStateDb();
  await upsertSubscription(db, {
    userDid,
    endpoint: body.endpoint,
    kind,
    p256dh,
    auth: authKey,
    expirationTime:
      typeof expirationTimeRaw === "number" ? expirationTimeRaw : null,
  });
};
