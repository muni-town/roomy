/**
 * XRPC handler glue for the auth unit (`src/auth/access.ts`).
 *
 * The auth unit returns decisions; this module is the only place where those
 * decisions become HTTP semantics. Handlers import from here, not from
 * `src/auth/`. Keeping the translation in one file means the auth unit can be
 * driven directly by model-based tests without going through XRPC.
 */

import type { DbLike } from "../db/types.ts";
import { type, UserDid, type UserDid as UserDidT } from "@roomy-space/sdk";
import {
  type RoomAccess,
  type SpaceAccess,
  allowsPublicJoin,
  roomAccess,
  spaceAccess,
} from "../auth/access.ts";
import { XrpcError } from "./errors.ts";
import type { AuthCtx } from "./types.ts";

/**
 * Parse the caller's DID from auth context into a UserDid, or return null
 * for anonymous callers. Handlers that support anonymous access should use
 * this instead of calling `UserDid(auth.did)` directly.
 */
export function parseUserDid(auth: AuthCtx): UserDidT | null {
  if (auth.did === null) return null;
  const parsed = UserDid(auth.did);
  if (parsed instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${parsed.summary}`,
    );
  }
  return parsed;
}

/**
 * Caller must be a member or admin of the space, and not banned. Returns the
 * full access decision so handlers don't re-query.
 */
export async function requireSpaceAccess(
  db: DbLike,
  spaceId: string,
  did: string | null,
): Promise<SpaceAccess> {
  if (did === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }
  const access = await spaceAccess(db, spaceId, did);
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
 * Caller must have read access to the space (member, admin, OR public space
 * with allowPublicJoin). Unlike requireSpaceAccess, this allows anonymous
 * access to public spaces. Returns the full access decision.
 */
export async function requireSpaceRead(
  db: DbLike,
  spaceId: string,
  did: string | null,
): Promise<SpaceAccess> {
  const access = await spaceAccess(db, spaceId, did);
  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }
  if (!access.isMember && !access.isAdmin) {
    // Allow anonymous/member access if the space allows public join.
    if (!(await allowsPublicJoin(db, spaceId))) {
      throw new XrpcError(
        403,
        "Forbidden",
        "Caller is neither a member nor an admin of this space",
      );
    }
  }
  return access;
}

/**
 * Caller must have read access to the room. 404 if the room doesn't exist,
 * 403 otherwise. Returns the full access decision.
 */
export async function requireRoomRead(
  db: DbLike,
  roomId: string,
  did: string | null,
): Promise<RoomAccess> {
  const access = await roomAccess(db, roomId, did);
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
export async function requireRoomWrite(
  db: DbLike,
  roomId: string,
  did: string | null,
): Promise<RoomAccess> {
  const access = await roomAccess(db, roomId, did);
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
