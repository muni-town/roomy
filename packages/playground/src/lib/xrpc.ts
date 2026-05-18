/**
 * Playground XRPC call helpers.
 *
 * After Slice 3 these are one-line wrappers over the validated transport
 * helpers in `@roomy-space/sdk`. The wrappers take the appserver-proxied
 * `Agent` factory inline so call sites stay short.
 *
 * OAuth lifecycle (initSession, login, logout, makeProxiedAgent) lives in
 * `@roomy-space/sdk/browser`.
 */

import type { Agent } from "@atproto/api";
import { makeProxiedAgent } from "@roomy-space/sdk/browser";
import { transport } from "@roomy-space/sdk";

const { agentQuery, agentProcedure } = transport;

// ── NSID constants ────────────────────────────────────────────────────────
// Kept for any UI code (e.g. debug routes) that still wants a string handle.

const NSID_CONNECT_SPACE = "space.roomy.admin.connectSpace";
const NSID_MATERIALIZE_SPACE = "space.roomy.admin.materializeSpace";
const NSID_GET_MEMBERS = "space.roomy.space.getMembers";
const NSID_GET_SPACE_METADATA = "space.roomy.space.getMetadata";
const NSID_GET_SPACE_THREADS = "space.roomy.space.getThreads";
const NSID_GET_ROLES = "space.roomy.space.getRoles";
const NSID_GET_INVITES = "space.roomy.space.getInvites";
const NSID_GET_ROOM_METADATA = "space.roomy.room.getMetadata";
const NSID_GET_ROOM_THREADS = "space.roomy.room.getThreads";
const NSID_GET_MESSAGE = "space.roomy.message.getMessage";

// ── Helper ────────────────────────────────────────────────────────────────

function proxied(agent: Agent, appserverDid: string): Agent {
  return makeProxiedAgent(agent, appserverDid);
}

// ── Typed XRPC call helpers (Slice 3) ─────────────────────────────────────

export function callTicket(agent: Agent, appserverDid: string) {
  return agentProcedure(
    proxied(agent, appserverDid),
    "space.roomy.auth.getConnectionTicket",
    {},
  );
}

export function callGetSpaces(agent: Agent, appserverDid: string) {
  return agentQuery(proxied(agent, appserverDid), "space.roomy.space.getSpaces", {});
}

export function callGetSpaceMetadata(
  agent: Agent,
  appserverDid: string,
  spaceId: string,
) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.space.getMetadata",
    { spaceId },
  );
}

export function callGetSpaceThreads(
  agent: Agent,
  appserverDid: string,
  spaceId: string,
) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.space.getThreads",
    { spaceId },
  );
}

export function callGetRoles(agent: Agent, appserverDid: string, spaceId: string) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.space.getRoles",
    { spaceId },
  );
}

export function callGetMembers(
  agent: Agent,
  appserverDid: string,
  spaceId: string,
) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.space.getMembers",
    { spaceId },
  );
}

export function callGetInvites(
  agent: Agent,
  appserverDid: string,
  spaceId: string,
) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.space.getInvites",
    { spaceId },
  );
}

export function callGetRoomMetadata(
  agent: Agent,
  appserverDid: string,
  roomId: string,
) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.room.getMetadata",
    { roomId },
  );
}

export function callGetRoomThreads(
  agent: Agent,
  appserverDid: string,
  roomId: string,
) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.room.getThreads",
    { roomId },
  );
}

export function callGetMessages(
  agent: Agent,
  appserverDid: string,
  roomId: string,
  limit?: string,
  cursor?: string,
) {
  const params: { roomId: string; limit?: string; cursor?: string } = { roomId };
  if (limit) params.limit = limit;
  if (cursor) params.cursor = cursor;
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.room.getMessages",
    params,
  );
}

export function callGetMessage(
  agent: Agent,
  appserverDid: string,
  messageId: string,
) {
  return agentQuery(
    proxied(agent, appserverDid),
    "space.roomy.message.getMessage",
    { messageId },
  );
}

export function callUpdateSeen(
  agent: Agent,
  appserverDid: string,
  roomId: string,
  seenUpTo?: string,
) {
  const body: { roomId: string; seenUpTo?: string } = { roomId };
  if (seenUpTo) body.seenUpTo = seenUpTo;
  return agentProcedure(
    proxied(agent, appserverDid),
    "space.roomy.room.updateSeen",
    body,
  );
}

// ── Untyped helpers (no arktype schema yet) ───────────────────────────────
// FLAG: `space.roomy.admin.connectSpace` and `space.roomy.admin.materializeSpace`
// have no schema in packages/sdk/src/schemas/. They're left as raw `.call()`
// passthroughs until Slice 1 adds schemas for them.

export async function callConnectSpace(
  agent: Agent,
  appserverDid: string,
  did: string,
) {
  const p = proxied(agent, appserverDid);
  const response = await p.call(NSID_CONNECT_SPACE, { did });
  return response.data;
}

export async function callMaterializeSpace(
  agent: Agent,
  appserverDid: string,
  did: string,
  waitBackfill: boolean,
) {
  const p = proxied(agent, appserverDid);
  const params: Record<string, string> = { did };
  if (waitBackfill) params.wait = "backfill";
  const response = await p.call(NSID_MATERIALIZE_SPACE, params);
  return response.data;
}

// ── Generic helpers (used by the debug page) ──────────────────────────────
// These bypass schema validation; prefer the typed `callXxx` thunks above.

export async function callSpaceQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  spaceId: string,
) {
  const p = proxied(agent, appserverDid);
  const response = await p.call(nsid, { spaceId });
  return response.data;
}

export async function callRoomQuery(
  agent: Agent,
  appserverDid: string,
  nsid: string,
  roomId: string,
) {
  const p = proxied(agent, appserverDid);
  const response = await p.call(nsid, { roomId });
  return response.data;
}

export const NSIDS = {
  GET_MEMBERS: NSID_GET_MEMBERS,
  GET_SPACE_METADATA: NSID_GET_SPACE_METADATA,
  GET_SPACE_THREADS: NSID_GET_SPACE_THREADS,
  GET_ROLES: NSID_GET_ROLES,
  GET_INVITES: NSID_GET_INVITES,
  GET_ROOM_METADATA: NSID_GET_ROOM_METADATA,
  GET_ROOM_THREADS: NSID_GET_ROOM_THREADS,
  GET_MESSAGE: NSID_GET_MESSAGE,
} as const;
