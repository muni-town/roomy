/**
 * XRPC: space.roomy.admin.push.getSubscriptions (query).
 *
 * Returns all push subscriptions stored for a user: the transport that reaches
 * each one (`kind`), the endpoint, whether keys are present, expiration time,
 * and created/updated timestamps. Used to diagnose why notifications aren't
 * reaching a device. `pushService` is the endpoint's hostname when it is a
 * URL, which immediately shows which browser push service a Web Push row
 * routes through; a native row's endpoint is a device token rather than a URL,
 * so `kind` — not the hostname — is what identifies it.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openReadStateDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface SubscriptionResult {
  endpoint: string;
  /** The transport that reaches this device: `webpush`, `apns`, `fcm`, `sse`. */
  kind: string;
  /** Push service domain extracted from the endpoint URL, for Web Push rows. */
  pushService: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
  createdAt: number;
  updatedAt: number;
}

interface GetSubscriptionsResult {
  userDid: string;
  subscriptions: SubscriptionResult[];
}

export const adminGetSubscriptionsHandler: QueryHandler<
  QueryParams,
  GetSubscriptionsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const userDid = params.did;
  if (typeof userDid !== "string" || userDid === "") {
    throw new XrpcError(400, "InvalidRequest", "Missing or empty query param: did");
  }

  const db = openReadStateDb();
  const rows = await db.query(
    "select endpoint, kind, p256dh, auth, expiration_time, created_at, updated_at from push_subscriptions where user_did = ? order by updated_at desc",
  ).all<{
    endpoint: string;
    kind: string;
    p256dh: string;
    auth: string;
    expiration_time: number | null;
    created_at: number;
    updated_at: number;
  }>(userDid);

  return {
    userDid,
    subscriptions: rows.map((r) => {
      let pushService = "unknown";
      try {
        pushService = new URL(r.endpoint).hostname;
      } catch {
        // endpoint isn't a valid URL — leave as "unknown"
      }
      return {
        endpoint: r.endpoint,
        kind: r.kind,
        pushService,
        p256dh: r.p256dh,
        auth: r.auth,
        expirationTime: r.expiration_time,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }),
  };
};