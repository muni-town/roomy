/**
 * TanStack query factories — thin wrappers over the validated XRPC helpers
 * in `$lib/xrpc`. Each factory returns a `queryFn`-compatible thunk so
 * `createQuery({ queryFn: fetchXxx(agent, did, ...) })` stays a one-liner.
 */

import type { Agent } from "@atproto/api";
import {
  callTicket,
  callGetSpaces,
  callGetSpaceMetadata,
  callGetSpaceThreads,
  callGetRoles,
  callGetMembers,
  callGetRoomMetadata,
  callGetRoomThreads,
  callGetMessages,
  callUpdateSeen,
} from "$lib/xrpc";

// ── NSIDs (kept as string constants for `queryKey` use) ───────────────────

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

export function queryKey(
  nsid: string,
  params: Record<string, string>,
): [string, Record<string, string>] {
  return [nsid, params];
}

// ── Query factories (queryFn thunks for TanStack `createQuery`) ───────────

export const fetchGetSpaces = (agent: Agent, did: string) => () =>
  callGetSpaces(agent, did);

export const fetchSpaceMetadata =
  (agent: Agent, did: string, spaceId: string) => () =>
    callGetSpaceMetadata(agent, did, spaceId);

export const fetchSpaceThreads =
  (agent: Agent, did: string, spaceId: string) => () =>
    callGetSpaceThreads(agent, did, spaceId);

export const fetchRoomMetadata =
  (agent: Agent, did: string, roomId: string) => () =>
    callGetRoomMetadata(agent, did, roomId);

export const fetchMessages =
  (agent: Agent, did: string, roomId: string, limit = 50, cursor?: string) =>
  () =>
    callGetMessages(agent, did, roomId, String(limit), cursor);

export const fetchRoomThreads =
  (agent: Agent, did: string, roomId: string) => () =>
    callGetRoomThreads(agent, did, roomId);

export const fetchMembers =
  (agent: Agent, did: string, spaceId: string) => () =>
    callGetMembers(agent, did, spaceId);

export const fetchRoles =
  (agent: Agent, did: string, spaceId: string) => () =>
    callGetRoles(agent, did, spaceId);

export const callUpdateSeenRoom =
  (agent: Agent, did: string, roomId: string, seenUpTo?: string) => () =>
    callUpdateSeen(agent, did, roomId, seenUpTo);

export const fetchTicket = (agent: Agent, did: string) => async () => {
  const res = await callTicket(agent, did);
  return res.ticket;
};
