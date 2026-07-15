/**
 * Appserver admin XRPC debug helpers.
 *
 * Typed call wrappers for the admin dashboard's XRPC debug tools.
 * Each function takes an Agent and appserver DID (from the auth module)
 * and returns the raw response data.
 *
 * OAuth lifecycle (initSession, login, logout) lives in
 * `@roomy-space/sdk/browser`.
 */

import type { Agent } from "@atproto/api";
import { makeProxiedAgent } from "@roomy-space/sdk/browser";
import { transport } from "@roomy-space/sdk";

const { agentQuery, agentProcedure } = transport;

// ── NSID constants (used by the debug page's NSID picker) ─────────────────

export const NSIDS = {
  GET_MEMBERS: "space.roomy.space.getMembers",
  GET_SPACE_METADATA: "space.roomy.space.getMetadata",
  GET_SPACE_THREADS: "space.roomy.space.getThreads",
  GET_ROLES: "space.roomy.space.getRoles",
  GET_INVITES: "space.roomy.space.getInvites",
  GET_ROOM_METADATA: "space.roomy.room.getMetadata",
  GET_ROOM_THREADS: "space.roomy.room.getThreads",
  GET_MESSAGE: "space.roomy.message.getMessage",
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────

function proxied(agent: Agent, appserverDid: string): Agent {
  return makeProxiedAgent(agent, appserverDid);
}

// ── Typed call helpers used by the debug page ─────────────────────────────

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

// ── Untyped helpers (no arktype schema yet) ───────────────────────────────
// FLAG: `space.roomy.admin.connectSpace` and `space.roomy.admin.materializeSpace`
// have no schema in packages/sdk/src/schemas/. They're left as raw `.call()`
// passthroughs until schemas are added for them.

export async function callConnectSpace(
  agent: Agent,
  appserverDid: string,
  did: string,
) {
  const p = proxied(agent, appserverDid);
  const response = await p.call("space.roomy.admin.connectSpace", { did });
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
  const response = await p.call("space.roomy.admin.materializeSpace", params);
  return response.data;
}

// ── Generic helpers (used by the debug page NSID picker) ──────────────────

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

// ── Feature flag helpers (untyped, admin-only) ──────────────────────────

export async function callGetFlags(
  agent: Agent,
  appserverDid: string,
) {
  const p = proxied(agent, appserverDid);
  const response = await p.call("space.roomy.getFlags", {});
  return response.data as { flags: string[] };
}

export async function callAdminGetFlags(
  agent: Agent,
  appserverDid: string,
) {
  const p = proxied(agent, appserverDid);
  const response = await p.call("space.roomy.admin.getFlags", {});
  return response.data as {
    flags: Array<{
      key: string;
      description: string;
      globalEnabled: boolean;
      assignedDids: string[];
    }>;
  };
}

export async function callAdminSetFlag(
  agent: Agent,
  appserverDid: string,
  flag: string,
  all?: boolean,
  userDids?: string[],
) {
  const p = proxied(agent, appserverDid);
  const body: Record<string, unknown> = { flag };
  if (all !== undefined) body.all = all;
  if (userDids !== undefined) body.userDids = userDids;
  const response = await p.call("space.roomy.admin.setFlag", {}, body);
  return response.data;
}

export async function callAdminClearFlag(
  agent: Agent,
  appserverDid: string,
  flag: string,
) {
  const p = proxied(agent, appserverDid);
  const response = await p.call("space.roomy.admin.clearFlag", {}, { flag });
  return response.data;
}
