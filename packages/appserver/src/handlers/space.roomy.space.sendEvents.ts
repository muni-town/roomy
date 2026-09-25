/**
 * XRPC: space.roomy.space.sendEvents (procedure).
 *
 * Sends a batch of Roomy events to a space stream through the appserver.
 * The appserver validates authorization per-event, then writes events directly
 * to the events DB and materializes inline.
 *
 * @see packages/appserver/docs/plans/sendEvents-procedure.md
 */

import { parseEvent, type Event, StreamDid } from "@roomy-space/sdk";
import { withSpan } from "../telemetry/tracing.ts";
import { log } from "../log.ts";
import { openGlobalDb, openSpaceDb } from "../db/db.ts";
import {
  checkWriteAuth,
  prewarmWriteAuthAccess,
  type WriteAuthContext,
} from "../auth/writeAuth.ts";
import { createAccessMemo, spaceAccess } from "../auth/access.ts";
import { createFederationMemo } from "../auth/federation.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";
import {
  getStreamManager,
  SpaceRematerializingError,
} from "../streams/StreamManager.ts";

const MAX_BATCH_SIZE = 50;

interface SendEventsBody {
  spaceId?: unknown;
  events?: unknown;
}

/**
 * Entry point. The span covers the whole request so a slow `sendEvents` is
 * attributable to a phase (access / authorize / write) rather than being one
 * opaque latency number.
 */
export const sendEventsHandler: ProcedureHandler<SendEventsBody, void> = async (
  params: QueryParams,
  auth: AuthCtx,
  body: SendEventsBody,
) =>
  withSpan(
    "space.roomy.space.sendEvents",
    {
      "roomy.event_count": Array.isArray(body.events) ? body.events.length : 0,
      ...(typeof body.spaceId === "string"
        ? { "roomy.space_id": body.spaceId }
        : {}),
    },
    () => sendEventsImpl(params, auth, body),
  );

async function sendEventsImpl(
  _params: QueryParams,
  auth: AuthCtx,
  body: SendEventsBody,
) {
  // 1. Validate input
  if (typeof body.spaceId !== "string" || body.spaceId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceId",
    );
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: events",
    );
  }
  if (body.events.length > MAX_BATCH_SIZE) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Too many events: max ${MAX_BATCH_SIZE}`,
    );
  }

  const spaceId = body.spaceId;
  // Narrowed once here: the guard above proves it, but TS loses the narrowing
  // inside the callbacks below (the `body` property read is not re-invoked in
  // a way the compiler can track).
  const events = body.events;
  const callerDid = parseUserDid(auth);
  if (callerDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  log.info("sendEvents", { spaceId, callerDid, count: events.length });
  // Hoisted above the ban check: the service's own DID is exempt from it.
  const streamManager = getStreamManager();
  const db = openSpaceDb(spaceId);
  // Space access is resolved here (for writeAuth + to reject banned callers)
  // but NOT treated as a hard gate: a caller who is not a member/admin of the
  // target space may still be a member of a *federated* space and authorized
  // to write to a federated channel. Per-event `writeAuth` is the sole
  // authority on what the caller may send — it denies events that require
  // membership/admin and allows federated room writes.
  const access = await withSpan("sendEvents.access", {}, async (s) => {
    const result = await spaceAccess(db, spaceId, callerDid);
    s.setAttribute("roomy.is_banned", result.isBanned);
    return result;
  });
  // A ban is a space-level gate on ordinary participants. The service DID is
  // not a participant: it is the authority that evaluates bans. Exempting it
  // here is what lets it emit its own events (the Pro members-role sweep)
  // even if an admin of the target space has banned it; `checkWriteAuth`
  // still refuses every event type outside SERVICE_SELF_WRITE_TYPES.
  if (access.isBanned && callerDid !== streamManager.ownDid) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }

  // 3. Validate + authorize each event
  const parsedEvents: (typeof Event.infer)[] = [];
  // Per-event write authorization is a DB round-trip each (auth edges,
  // membership, policy): the dominant cost for a large batch. One span
  // around the loop (rather than N) keeps the trace cheap while still
  // separating "authorize" from "write" when reading the waterfall.
  //
  // One context (and therefore one access memo + one federation memo) for
  // the whole batch: the per-event checks re-derive the same space-level
  // membership/admin/ban flags and the same room→space→parent→default_access
  // facts, and neither can differ between events in one request. The rooms
  // are resolved up front in one batched read (prewarmWriteAuthAccess), so
  // the loop's room checks are memo hits rather than an N+1 — without the
  // up-front batch, a 50-message batch to one room would re-resolve that room
  // 50 times.
  const authCtx: WriteAuthContext = {
    access,
    accessMemo: createAccessMemo(),
    federationMemo: createFederationMemo(),
    dbResolver: openSpaceDb,
    globalDb: openGlobalDb(),
    // The service's own DID is allowed to author a narrow set of events
    // (the Pro members-role sweep) without holding space membership or
    // admin — see SERVICE_SELF_WRITE_TYPES in auth/writeAuth.ts.
    serviceDid: streamManager.ownDid,
  };
  await withSpan(
    "sendEvents.authorize",
    { "roomy.event_count": events.length },
    async (s) => {
      // Raw events: validation errors are still produced by the loop below,
      // in batch order, exactly as before.
      await prewarmWriteAuthAccess(
        db,
        events as Array<Record<string, unknown>>,
        callerDid,
        authCtx.accessMemo!,
      );
      for (let i = 0; i < events.length; i++) {
        const raw = events[i];
        if (typeof raw !== "object" || raw === null) {
          throw new XrpcError(
            400,
            "InvalidRequest",
            `Event at index ${i} is not an object`,
          );
        }
        const parsed = parseEvent(raw);
        if (!parsed.success) {
          throw new XrpcError(
            400,
            "InvalidRequest",
            `Event at index ${i} is invalid: ${parsed.error}`,
          );
        }
        const event = parsed.data;
        const denial = await checkWriteAuth(
          db,
          spaceId,
          callerDid,
          event,
          authCtx,
        );
        if (denial) {
          throw new XrpcError(
            denial.status,
            denial.error,
            denial.message,
          );
        }
        parsedEvents.push(event);
      }
      s.setAttribute("roomy.authorized_count", parsedEvents.length);
    },
  );
  log.debug("sendEvents", "validated", { spaceId, count: parsedEvents.length });

  // 4. Write to events DB + materialize inline
  log.info("sendEvents", "writing to events DB", { spaceId, count: parsedEvents.length });
  const streamDid = StreamDid.assert(spaceId);
  // The write + inline materialization: where a space-local bottleneck
  // (pool saturation, SQLite writer contention) actually shows up.
  await withSpan("sendEvents.write", {}, async () => {
    try {
      await streamManager.sendEvents(streamDid, parsedEvents, callerDid);
    } catch (err) {
      // Blue-green: a write to a space that is currently being
      // rebuilt is rejected before it lands in the event log. Surface it as a
      // retryable 409 so clients can back off and retry once the rebuild
      // commits — not a 500 (the write is safe to retry; nothing applied).
      if (err instanceof SpaceRematerializingError) {
        throw new XrpcError(
          409,
          "SpaceRematerializing",
          `Space ${spaceId} is being rematerialized; retry the write shortly`,
        );
      }
      throw err;
    }
  });

  log.info("sendEvents", "done", { spaceId, count: parsedEvents.length });
};
