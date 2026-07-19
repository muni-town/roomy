/**
 * XRPC: space.roomy.admin.push.getSubscriptions (query).
 *
 * Returns all push subscriptions stored for a user, including the endpoint
 * URL (which reveals the push service — fcm.googleapis.com for Chrome,
 * updates.push.services.mozilla.com for Firefox, api.push.apple for Safari),
 * whether the keys are present, expiration time, and created/updated
 * timestamps. Used to diagnose why notifications aren't reaching a specific
 * browser — the endpoint domain immediately shows which push service the
 * subscription routes through.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface SubscriptionResult {
  endpoint: string;
  /** Push service domain extracted from the endpoint URL. */
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

  const db = openDb();
  const rows = await db.query(
    "select endpoint, p256dh, auth, expiration_time, created_at, updated_at from readstate.push_subscriptions where user_did = ? order by updated_at desc",
  ).all<{
    endpoint: string;
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