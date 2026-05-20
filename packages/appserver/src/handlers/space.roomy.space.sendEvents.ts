/**
 * XRPC: space.roomy.space.sendEvents (procedure).
 *
 * Sends a batch of Roomy events to a space stream through the appserver.
 * The appserver validates authorization per-event, then proxies the batch
 * to Leaf with `userOverride` set to the caller's DID.
 *
 * @see packages/appserver/docs/plans/sendEvents-procedure.md
 */

import { parseEvent, type Event } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { sendEventsToStream } from "../serviceClient.ts";
import { checkWriteAuth } from "../auth/writeAuth.ts";
import { requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

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
      `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`,
    );
  }

  const spaceId = body.spaceId;
  const callerDid = auth.did;
  const db = openDb();

  // 2. Verify space exists and caller has access
  requireSpaceAccess(db, spaceId, callerDid);

  // 3. Validate + authorize each event
  const parsedEvents: (typeof Event.infer)[] = [];
  for (let i = 0; i < body.events.length; i++) {
    const raw = body.events[i];

    // Schema validation
    const result = parseEvent(raw);
    if (!result.success) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        `Event at index ${i} failed validation: ${result.error}`,
      );
    }

    // Authorization
    const denial = checkWriteAuth(db, spaceId, callerDid, result.data);
    if (denial) {
      throw new XrpcError(
        denial.status,
        denial.error,
        `Event at index ${i} ($type: ${result.data.$type}): ${denial.message}`,
      );
    }

    parsedEvents.push(result.data);
  }

  // 4. Proxy to Leaf (bypasses ConnectedSpace module check)
  await sendEventsToStream(spaceId as any /* StreamDid */, parsedEvents, callerDid);
};
