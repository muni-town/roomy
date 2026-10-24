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
 *  - `sse` registers an application that holds a stream open (see
 *    `push/transports/sse.ts`). `endpoint` is a random id, validated by
 *    `isSecureId`. A did can request up to `MAX_SSE_SUBSCRIPTIONS_PER_USER`
 *     of them with the oldest being evicted.
 *
 * An unknown `kind` is rejected: it would be stored and then counted as a
 * failure by the dispatcher on every delivery, which hides a typo behind a
 * runtime symptom instead of reporting it at registration.
 */

import { openReadStateDb } from "../db/db.ts";
import {
  evictOldestSseSubscriptions,
  upsertSubscription,
} from "../queries/pushSubscriptions.ts";
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

const MAX_SSE_SUBSCRIPTIONS_PER_USER = 10;
const SECURE_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

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


  // * TODO: this is underspecified. The length floor does not guarantee a bit
  // * count, because the alphabet is not pinned: 22 hex characters is only 88
  // * bits. Decide what the client generates (a UUIDv4, or 16+ random bytes as
  // * base64url) and tighten the pattern to exactly that. A distinct-character
  // * count also cannot prove randomness, only reject obvious junk. If that is not
  // * enough, the server could issue the id at registration instead.
  /*
   * Whether `value` is a suffucuently high entrpoy random identifier.
   *
   * Shape: 22 to 64 characters from `A-Za-z0-9_-`. That admits a UUID (36), 16
   * random bytes as base64url (22) and 32 random bytes as base64url (43). And
   * at least {@link MIN_DISTINCT_CHARACTERS} different characters.
   */
  if (kind === "sse" && (typeof body.endpoint !== 'string' ||
    !SECURE_ID_PATTERN.test(body.endpoint) ||
    new Set(body.endpoint).size < 10)) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field 'endpoint' must be a client-generated random id for kind 'sse'",
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

  if (kind === "sse") {
    await evictOldestSseSubscriptions(
      db,
      userDid,
      MAX_SSE_SUBSCRIPTIONS_PER_USER,
    );
  }
};
