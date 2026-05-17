import type { Agent } from "@atproto/api";
import { makeProxiedAgent } from "@roomy-space/sdk/browser";
import { callUpdateSeen } from "$lib/xrpc";

// ── NSIDs ─────────────────────────────────────────────────────────────────

export const NSID = {
	GET_SPACES: "space.roomy.space.getSpaces",
	GET_SPACE_METADATA: "space.roomy.space.getMetadata",
	GET_SPACE_THREADS: "space.roomy.space.getThreads",
	GET_ROLES: "space.roomy.space.getRoles",
	GET_MEMBERS: "space.roomy.space.getMembers",
	GET_INVITES: "space.roomy.space.getInvites",
	GET_ROOM_METADATA: "space.roomy.room.getMetadata",
	GET_ROOM_THREADS: "space.roomy.room.getThreads",
	GET_MESSAGES: "space.roomy.room.getMessages",
	GET_MESSAGE: "space.roomy.message.getMessage",
	GET_TICKET: "space.roomy.auth.getConnectionTicket",
	UPDATE_SEEN: "space.roomy.room.updateSeen",
} as const;

// ── Query key helpers ─────────────────────────────────────────────────────
// Every query uses [nsid, params] — maps directly to #invalidate frame format.

export function queryKey(nsid: string, params: Record<string, string>): [string, Record<string, string>] {
	return [nsid, params];
}

// ── XRPC fetch wrapper ────────────────────────────────────────────────────

function proxied(agent: Agent, appserverDid: string): Agent {
	return makeProxiedAgent(agent, appserverDid);
}

async function xrpcFetch<T>(
	agent: Agent,
	appserverDid: string,
	nsid: string,
	params: Record<string, string> = {},
): Promise<T> {
	const p = proxied(agent, appserverDid);
	const response = await p.call(nsid, params);
	return response.data as T;
}

// ── Query functions (for use in createQuery queryFn) ──────────────────────

export function fetchGetSpaces(agent: Agent, appserverDid: string) {
	return () => xrpcFetch<import("./types").GetSpacesResponse>(agent, appserverDid, NSID.GET_SPACES);
}

export function fetchSpaceMetadata(agent: Agent, appserverDid: string, spaceId: string) {
	return () => xrpcFetch<import("./types").GetSpaceMetadataResponse>(
		agent, appserverDid, NSID.GET_SPACE_METADATA, { spaceId },
	);
}

export function fetchSpaceThreads(agent: Agent, appserverDid: string, spaceId: string) {
	return () => xrpcFetch<import("./types").GetSpaceThreadsResponse>(
		agent, appserverDid, NSID.GET_SPACE_THREADS, { spaceId },
	);
}

export function fetchRoomMetadata(agent: Agent, appserverDid: string, roomId: string) {
	return () => xrpcFetch<import("./types").GetRoomMetadataResponse>(
		agent, appserverDid, NSID.GET_ROOM_METADATA, { roomId },
	);
}

export function fetchMessages(
	agent: Agent,
	appserverDid: string,
	roomId: string,
	limit = 50,
	cursor?: string,
) {
	const params: Record<string, string> = { roomId, limit: String(limit) };
	if (cursor) params.cursor = cursor;
	return () => xrpcFetch<import("./types").GetMessagesResponse>(
		agent, appserverDid, NSID.GET_MESSAGES, params,
	);
}

export function fetchRoomThreads(agent: Agent, appserverDid: string, roomId: string) {
	return () => xrpcFetch<import("./types").GetRoomThreadsResponse>(
		agent, appserverDid, NSID.GET_ROOM_THREADS, { roomId },
	);
}

export function fetchMembers(agent: Agent, appserverDid: string, spaceId: string) {
	return () => xrpcFetch<import("./types").GetMembersResponse>(
		agent, appserverDid, NSID.GET_MEMBERS, { spaceId },
	);
}

export function fetchRoles(agent: Agent, appserverDid: string, spaceId: string) {
	return () => xrpcFetch<import("./types").GetRolesResponse>(
		agent, appserverDid, NSID.GET_ROLES, { spaceId },
	);
}

export function callUpdateSeenRoom(
	agent: Agent,
	appserverDid: string,
	roomId: string,
	seenUpTo?: string,
) {
	return () => callUpdateSeen(agent, appserverDid, roomId, seenUpTo);
}

export function fetchTicket(agent: Agent, appserverDid: string) {
	return async () => {
		const p = proxied(agent, appserverDid);
		const response = await p.call(NSID.GET_TICKET);
		return (response.data as { ticket: string }).ticket;
	};
}
