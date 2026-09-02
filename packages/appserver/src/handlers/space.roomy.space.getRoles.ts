/**
 * XRPC: space.roomy.space.getRoles (query).
 *
 * Returns roles defined in a space with their per-room permissions and
 * assigned member DIDs. Soft-deleted roles are omitted.
 */

import { openSpaceDb } from "../db/db.ts";
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

	const db = openSpaceDb(spaceId);
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

	// Per-role rooms + members, fetched in TWO batched queries (WHERE stream_id = ?)
	// and grouped by role_id in JS — instead of 2 round-trips per role (N+1).
	const roomRows = await db
		.query(
			`select role_id, room_id, permission from role_rooms
        where stream_id = ?`,
		)
		.all<{ role_id: string; room_id: string; permission: "read" | "readwrite" }>(spaceId);
	const roomsByRole = new Map<string, RoleRoom[]>();
	for (const row of roomRows) {
		const list = roomsByRole.get(row.role_id) ?? [];
		list.push({ roomId: row.room_id, permission: row.permission });
		roomsByRole.set(row.role_id, list);
	}

	const memberRows = await db
		.query(
			`select role_id, user_id from member_roles
        where stream_id = ?`,
		)
		.all<{ role_id: string; user_id: string }>(spaceId);
	const membersByRole = new Map<string, string[]>();
	for (const row of memberRows) {
		const list = membersByRole.get(row.role_id) ?? [];
		list.push(row.user_id);
		membersByRole.set(row.role_id, list);
	}

	const roles: RoleRow[] = roleRows
		.map((r) =>
			stripNulls({
				id: r.id,
				name: r.name,
				avatar: r.avatar,
				description: r.description,
				rooms: roomsByRole.get(r.id) ?? [],
				memberDids: membersByRole.get(r.id) ?? [],
			}) as RoleRow,
		)
		.filter(
			(r) => access.isAdmin || (userDid !== null && r.memberDids.includes(userDid)),
		);

	return { roles };
};
