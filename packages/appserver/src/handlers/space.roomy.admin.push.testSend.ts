/**
 * XRPC: space.roomy.admin.push.testSend (procedure).
 *
 * Sends a test push payload to ALL of a user's stored subscription endpoints
 * and returns the per-endpoint delivery result: HTTP status, error message,
 * `gone` flag, `skipped` flag, and the push service domain. This is the primary
 * diagnostic for "why isn't this user getting notifications on Chrome" — it
 * bypasses the evaluation/enumeration pipeline and tests the raw delivery path,
 * showing exactly what each push service (FCM, Mozilla, Apple) returns.
 *
 * The payload is a real `message`-type push (identical structure to what the
 * dispatcher sends) so the browser shows a real notification if delivery
 * succeeds — confirming end-to-end that the SW → showNotification path works.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openReadStateDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
// Side effect: registers the Web Push transport in `PUSH_TRANSPORTS`.
import "../push/transports/webPush.ts";
import { PUSH_TRANSPORTS } from "../push/transports/types.ts";
import { selectSubscriptions } from "../queries/pushSubscriptions.ts";
import { pruneSubscriptionByEndpoint } from "../queries/pushSubscriptions.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface TestSendBody {
  did?: unknown;
  /** Optional: send to only this endpoint (by hostname or full endpoint URL). */
  endpoint?: unknown;
}

interface EndpointResult {
  endpoint: string;
  /** Push service domain (fcm.googleapis.com, updates.push.services.mozilla.com, etc.) */
  pushService: string;
  /** HTTP status from the push service, or null if delivery was skipped. */
  status: number | null;
  /** True if the push service indicated the subscription is gone (404/410). */
  gone: boolean;
  /**
   * True if no transport attempted delivery: the row's transport isn't
   * registered in this build, or it declined (Web Push with VAPID unset).
   * Distinct from a delivery, so an unconfigured pipeline is not reported as
   * one that works.
   */
  skipped: boolean;
  /** Error message if delivery threw (429/5xx/network), null on success. */
  error: string | null;
}

interface TestSendResult {
  userDid: string;
  totalEndpoints: number;
  results: EndpointResult[];
}

export const adminTestSendHandler: ProcedureHandler<
  TestSendBody,
  TestSendResult
> = async (_params: QueryParams, auth: AuthCtx, body: TestSendBody) => {
  requireAdmin(auth);

  const userDid = body.did;
  if (typeof userDid !== "string" || userDid === "") {
    throw new XrpcError(400, "InvalidRequest", "Missing or empty required field: did");
  }

  const db = openReadStateDb();
  const subs = await selectSubscriptions(db, userDid);

  // Optional filter by endpoint hostname or full URL.
  let targetSubs = subs;
  if (typeof body.endpoint === "string" && body.endpoint !== "") {
    const filter = body.endpoint;
    targetSubs = subs.filter((s) => {
      try {
        const host = new URL(s.endpoint).hostname;
        return s.endpoint === filter || host === filter || s.endpoint.includes(filter);
      } catch {
        return s.endpoint.includes(filter);
      }
    });
  }

  const payload = JSON.stringify({
    type: "message" as const,
    spaceId: "admin-test",
    roomId: "admin-test",
    messageId: "admin-test",
    count: 1,
    roomName: "Admin Test",
    authorName: "Push Diagnostics",
    messageContent: "This is a test push from the admin diagnostics endpoint.",
  });

  const results: EndpointResult[] = [];

  for (const sub of targetSubs) {
    let pushService = "unknown";
    try {
      pushService = new URL(sub.endpoint).hostname;
    } catch {
      // Non-URL endpoint (a native device token, say) — leave "unknown".
    }

    const transport = PUSH_TRANSPORTS[sub.kind];
    if (!transport) {
      results.push({
        endpoint: sub.endpoint,
        pushService,
        status: null,
        gone: false,
        skipped: false,
        error: `No transport registered for kind '${sub.kind}'`,
      });
      continue;
    }

    try {
      const res = await transport.deliver(
        {
          kind: sub.kind,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
          expirationTime: sub.expirationTime,
        },
        payload,
        { urgency: "normal" },
      );

      if (res.outcome === "gone") {
        // Prune the dead subscription (same as the dispatcher does).
        await pruneSubscriptionByEndpoint(db, sub.endpoint);
      }

      results.push({
        endpoint: sub.endpoint,
        pushService,
        status: res.status,
        gone: res.outcome === "gone",
        skipped: res.outcome === "skipped",
        error:
          res.outcome === "retry"
            ? res.error instanceof Error
              ? res.error.message
              : String(res.error)
            : res.outcome === "skipped"
              ? "No transport attempted delivery for this subscription"
              : null,
      });
    } catch (err) {
      // A transport must not throw; report it like any other failure.
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        endpoint: sub.endpoint,
        pushService,
        status: null,
        gone: false,
        skipped: false,
        error: message,
      });
    }
  }

  return {
    userDid,
    totalEndpoints: targetSubs.length,
    results,
  };
};