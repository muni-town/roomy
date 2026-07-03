/**
 * XRPC: space.roomy.space.getRoles (query).
 *
 * Returns roles defined in a space with their per-room permissions and
 * assigned member DIDs. Soft-deleted roles are omitted.
 */

import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireSpaceAccess } from "../xrpc/authGuards.ts";
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
	const userDid = parseUserDid(auth);
	const spaceId = requireString(params, "spaceId");

	if (userDid !== null) {
		await hydrateUserMembership(userDid);
	}

	const db = openDb();
	const access = await requireSpaceAccess(db, spaceId, userDid);

	const roleRows = await db
		.query(
			`select id, name, avatar, description
           from roles
          where stream_id = ?
            and deleted = 0`,
		)
		.all<{
			id: string;
			name: string | null;
			avatar: string | null;
			description: string | null;
		}>(spaceId);

	const roomsStmt = db.query(
		`select room_id, permission from role_rooms
        where role_id = ? and stream_id = ?`,
	);

	const membersStmt = db.query(
		`select user_id from member_roles
        where role_id = ? and stream_id = ?`,
	);

	const roles: RoleRow[] = (await Promise.all(
		roleRows.map(
			async (r) =>
				stripNulls({
					id: r.id,
					name: r.name,
					avatar: r.avatar,
					description: r.description,
					rooms: (await roomsStmt.all(r.id, spaceId)).map((row) => ({
						roomId: row.room_id,
						permission: row.permission,
					})),
					memberDids: (await membersStmt.all(r.id, spaceId)).map((row) => row.user_id),
				}) as RoleRow,
		),
	)).filter(
		(r) => access.isAdmin || (userDid !== null && r.memberDids.includes(userDid)),
	);

	return { roles };
};
