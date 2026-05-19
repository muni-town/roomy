/**
 * XRPC handler glue for the auth unit (`src/auth/access.ts`).
 *
 * The auth unit returns decisions; this module is the only place where those
 * decisions become HTTP semantics. Handlers import from here, not from
 * `src/auth/`. Keeping the translation in one file means the auth unit can be
 * driven directly by model-based tests without going through XRPC.
 */

import type { Database } from "bun:sqlite";
import {
  type RoomAccess,
  type SpaceAccess,
  roomAccess,
  spaceAccess,
} from "../auth/access.ts";
import { XrpcError } from "./errors.ts";

/**
 * Caller must be a member or admin of the space, and not banned. Returns the
 * full access decision so handlers don't re-query.
 */
export function requireSpaceAccess(
  db: Database,
  spaceId: string,
  did: string,
): SpaceAccess {
  const access = spaceAccess(db, spaceId, did);
  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }
  if (!access.isMember && !access.isAdmin) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller is neither a member nor an admin of this space",
    );
  }
  return access;
}

/**
 * Caller must have read access to the room. 404 if the room doesn't exist,
 * 403 otherwise. Returns the full access decision.
 */
export function requireRoomRead(
  db: Database,
  roomId: string,
  did: string,
): RoomAccess {
  const access = roomAccess(db, roomId, did);
  if (!access.exists) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  if (!access.canRead) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller has no read access to this room",
    );
  }
  return access;
}

/**
 * Caller must have write access to the room. 404 if the room doesn't exist,
 * 403 if banned or no write permission. Returns the full access decision.
 */
export function requireRoomWrite(
  db: Database,
  roomId: string,
  did: string,
): RoomAccess {
  const access = roomAccess(db, roomId, did);
  if (!access.exists) {
    throw new XrpcError(404, "NotFound", `Room not found: ${roomId}`);
  }
  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }
  if (!access.canWrite) {
    throw new XrpcError(
      403,
      "Forbidden",
      "Caller does not have write access to this room",
    );
  }
  return access;
}
