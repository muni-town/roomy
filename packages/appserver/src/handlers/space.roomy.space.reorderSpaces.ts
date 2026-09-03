/**
 * XRPC: space.roomy.space.reorderSpaces (procedure).
 *
 * Reorders the caller's space list. The order is per-user appserver state
 * stored in the read-state DB (`space_order` table, schema v7) — NOT part of
 * the ATProto event stream (precedent: updateSeen / leaveSpace).
 *
 * The client sends the full ordered list of space DIDs it currently shows
 * (joined spaces only). The handler validates that every DID is a space the
 * caller has actually joined, then replaces the stored order in one
 * transaction. Spaces the caller joined but omitted from the list keep their
 * default position (they sort after the explicitly-ordered ones).
 */

import { openReadStateDb } from "../db/db.ts";
import { selectJoinedSpaceDids } from "../queries/userSpaceMembership.ts";
import { replaceSpaceOrder } from "../queries/spaceOrder.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { Router as InvalidationRouter } from "../invalidation/index.ts";
import type { StreamDid } from "@roomy-space/sdk";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface ReorderSpacesBody {
  spaceIds?: unknown;
}

export const reorderSpacesHandler: ProcedureHandler<ReorderSpacesBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: ReorderSpacesBody,
) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  if (!Array.isArray(body.spaceIds)) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: spaceIds",
    );
  }
  if (body.spaceIds.some((id) => typeof id !== "string" || id === "")) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "spaceIds must be an array of non-empty strings",
    );
  }
  const spaceIds = body.spaceIds as string[];

  const mainDb = openReadStateDb();

  // Validate: every listed space must be one the caller has joined. This
  // prevents a client from injecting arbitrary DIDs into the order.
  const joined = await selectJoinedSpaceDids(mainDb, userDid);
  const joinedSet = new Set(joined);
  for (const spaceId of spaceIds) {
    if (!joinedSet.has(spaceId as StreamDid)) {
      throw new XrpcError(
        403,
        "Forbidden",
        `Caller is not a member of space: ${spaceId}`,
      );
    }
  }

  await replaceSpaceOrder(mainDb, userDid, spaceIds as StreamDid[]);

  // Emit a direct getSpaces invalidation so the caller's WS connection
  // re-fetches the reordered list (same pattern as leaveSpace).
  const router = InvalidationRouter.getInstance();
  if (router) {
    router.emit([
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getSpaces",
          params: {},
          affectedUser: userDid,
        },
      },
    ]);
  }
};
