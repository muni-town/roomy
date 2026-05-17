/**
 * Playground XRPC call helpers.
 *
 * OAuth lifecycle (initSession, login, logout, makeProxiedAgent) has moved to
 * `@roomy-space/sdk/browser`.  This file retains only the thin XRPC call
 * wrappers that are specific to the playground UI; they will be replaced by
 * validated SDK transport helpers in Slice 3.
 */

import { Agent } from "@atproto/api";
import { makeProxiedAgent } from "@roomy-space/sdk/browser";

// ── NSID constants ────────────────────────────────────────────────────────

const NSID_TICKET = "space.roomy.auth.getConnectionTicket";
const NSID_CONNECT_SPACE = "space.roomy.admin.connectSpace";
const NSID_MATERIALIZE_SPACE = "space.roomy.admin.materializeSpace";
const NSID_GET_SPACES = "space.roomy.space.getSpaces";
const NSID_GET_MEMBERS = "space.roomy.space.getMembers";
const NSID_GET_SPACE_METADATA = "space.roomy.space.getMetadata";
const NSID_GET_SPACE_THREADS = "space.roomy.space.getThreads";
const NSID_GET_ROLES = "space.roomy.space.getRoles";
const NSID_GET_INVITES = "space.roomy.space.getInvites";
const NSID_GET_ROOM_METADATA = "space.roomy.room.getMetadata";
const NSID_GET_ROOM_THREADS = "space.roomy.room.getThreads";
const NSID_GET_MESSAGES = "space.roomy.room.getMessages";
const NSID_GET_MESSAGE = "space.roomy.message.getMessage";
const NSID_UPDATE_SEEN = "space.roomy.room.updateSeen";

// ── XRPC call helpers ─────────────────────────────────────────────────────

export async function callTicket(agent: Agent, appserverDid: string) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_TICKET);
  return response.data;
}

export async function callConnectSpace(agent: Agent, appserverDid: string, did: string) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_CONNECT_SPACE, { did });
  return response.data;
}

export async function callMaterializeSpace(
  agent: Agent,
  appserverDid: string,
  did: string,
  waitBackfill: boolean,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const params: Record<string, string> = { did };
  if (waitBackfill) params.wait = "backfill";
  const response = await proxied.call(NSID_MATERIALIZE_SPACE, params);
  return response.data;
}

export async function callGetSpaces(agent: Agent, appserverDid: string) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_GET_SPACES);
  return response.data;
}

export async function callSpaceQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  spaceId: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(nsid, { spaceId });
  return response.data;
}

export async function callRoomQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  roomId: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(nsid, { roomId });
  return response.data;
}

export async function callGetMessages(
  agent: Agent,
  appserverDid: string,
  roomId: string,
  limit?: string,
  cursor?: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const params: Record<string, string> = { roomId };
  if (limit) params.limit = limit;
  if (cursor) params.cursor = cursor;
  const response = await proxied.call(NSID_GET_MESSAGES, params);
  return response.data;
}

export async function callUpdateSeen(
  agent: Agent,
  appserverDid: string,
  roomId: string,
  seenUpTo?: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const body: Record<string, string> = { roomId };
  if (seenUpTo) body.seenUpTo = seenUpTo;
  const response = await proxied.call(NSID_UPDATE_SEEN, {}, body);
  return response.data;
}

export async function callGetMessage(
  agent: Agent,
  appserverDid: string,
  messageId: string,
) {
  const proxied = makeProxiedAgent(agent, appserverDid);
  const response = await proxied.call(NSID_GET_MESSAGE, { messageId });
  return response.data;
}

// ── NSID constants for space/room queries ──────────────────────────────────

export const NSIDS = {
  GET_MEMBERS: NSID_GET_MEMBERS,
  GET_SPACE_METADATA: NSID_GET_SPACE_METADATA,
  GET_SPACE_THREADS: NSID_GET_SPACE_THREADS,
  GET_ROLES: NSID_GET_ROLES,
  GET_INVITES: NSID_GET_INVITES,
  GET_ROOM_METADATA: NSID_GET_ROOM_METADATA,
  GET_ROOM_THREADS: NSID_GET_ROOM_THREADS,
} as const;
