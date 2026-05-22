/**
 * XRPC: space.roomy.space.getRoles (query).
 *
 * Returns roles defined in a space with their per-room permissions and
 * assigned member DIDs. Soft-deleted roles are omitted.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface RoleRoom {
  roomId: string;
  permission: "read" | "readwrite";
}

interface RoleRow {
  id: string;
  name?: string;
  avatar?: string;
  description?: string;
  rooms: RoleRoom[];
  memberDids: string[];
}

interface GetRolesResult {
  roles: RoleRow[];
}

export const getRolesHandler: QueryHandler<
  QueryParams,
  GetRolesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const spaceId = requireString(params, "spaceId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  requireSpaceAccess(db, spaceId, userDid);

  const roleRows = db
    .query<
      {
        id: string;
        name: string | null;
        avatar: string | null;
        description: string | null;
      },
      [string]
    >(
      `select id, name, avatar, description
           from roles
          where stream_id = ?
            and deleted = 0`,
    )
    .all(spaceId);

  const roomsStmt = db.query<
    { room_id: string; permission: "read" | "readwrite" },
    [string, string]
  >(
    `select room_id, permission from role_rooms
        where role_id = ? and stream_id = ?`,
  );

  const membersStmt = db.query<{ user_id: string }, [string, string]>(
    `select user_id from member_roles
        where role_id = ? and stream_id = ?`,
  );

  const roles: RoleRow[] = roleRows.map((r) =>
    stripNulls({
      id: r.id,
      name: r.name,
      avatar: r.avatar,
      description: r.description,
      rooms: roomsStmt.all(r.id, spaceId).map((row) => ({
        roomId: row.room_id,
        permission: row.permission,
      })),
      memberDids: membersStmt.all(r.id, spaceId).map((row) => row.user_id),
    }) as RoleRow,
  );

  return { roles };
};
