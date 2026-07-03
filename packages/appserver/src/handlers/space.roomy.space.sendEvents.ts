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
import { log } from "../log.ts";
import { openDb } from "../db/db.ts";
import { checkWriteAuth } from "../auth/writeAuth.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";
import { getStreamManager } from "../streams/StreamManager.ts";

const MAX_BATCH_SIZE = 50;

interface SendEventsBody {
  spaceId?: unknown;
  events?: unknown;
}

export const sendEventsHandler: ProcedureHandler<SendEventsBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: SendEventsBody,
) => {
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
  const callerDid = parseUserDid(auth);
  if (callerDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  log.info("sendEvents", { spaceId, callerDid, count: body.events.length });
  const db = openDb();
  const access = await requireSpaceAccess(db, spaceId, callerDid);

  // 3. Validate + authorize each event
  const parsedEvents: (typeof Event.infer)[] = [];
  for (let i = 0; i < body.events.length; i++) {
    const raw = body.events[i];
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
    const denial = await checkWriteAuth(db, spaceId, callerDid, event, access);
    if (denial) {
      throw new XrpcError(
        denial.status,
        denial.error,
        denial.message,
      );
    }
    parsedEvents.push(event);
  }
  log.debug("sendEvents", "validated", { spaceId, count: parsedEvents.length });

  // 4. Write to events DB + materialize inline
  const streamManager = getStreamManager();
  log.info("sendEvents", "writing to events DB", { spaceId, count: parsedEvents.length });
  const streamDid = StreamDid.assert(spaceId);
  await streamManager.sendEvents(streamDid, parsedEvents, callerDid);

  log.info("sendEvents", "done", { spaceId, count: parsedEvents.length });
};
