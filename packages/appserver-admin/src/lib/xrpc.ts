/**
 * Appserver admin XRPC debug helpers.
 *
 * Typed call wrappers for the admin dashboard's XRPC debug tools.
 * Uses DirectXrpcClient to talk directly to the appserver with service
 * auth tokens, bypassing the PDS proxy (which would need to resolve the
 * appserver's DID document — often a Tailscale/private address).
 *
 * OAuth lifecycle (initSession, login, logout) lives in
 * `@roomy-space/sdk/browser`.
 */

import type { Agent } from "@atproto/api";
import { transport } from "@roomy-space/sdk";
import { CONFIG } from "$lib/config";

const {
  DirectXrpcClient,
  ServiceAuthClient,
  resolveAppserverHttpOrigin,
} = transport;

// ── Shared DirectXrpcClient ────────────────────────────────────────────────
// Lazily initialised once the user's Agent is available. The appserver URL
// is resolved from the DID (or overridden via VITE_APPSERVER_WS_ORIGIN).

let _client: InstanceType<typeof DirectXrpcClient> | null = null;
let _serviceAuth: InstanceType<typeof ServiceAuthClient> | null = null;

async function getClient(agent: Agent): Promise<InstanceType<typeof DirectXrpcClient>> {
  if (_client) return _client;
  _serviceAuth = new ServiceAuthClient(agent);
  const appserverUrl =
    CONFIG.appserverHttpOrigin ??
    (await resolveAppserverHttpOrigin(CONFIG.appserverDid));
  _client = new DirectXrpcClient(appserverUrl, CONFIG.appserverDid, _serviceAuth);
  return _client;
}

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

// ── Typed call helpers used by the debug page ─────────────────────────────

export async function callTicket(agent: Agent) {
  const c = await getClient(agent);
  return c.procedure("space.roomy.auth.getConnectionTicket", {});
}

export async function callGetSpaces(agent: Agent) {
  const c = await getClient(agent);
  return c.query("space.roomy.space.getSpaces", {});
}

export async function callGetMessages(
  agent: Agent,
  roomId: string,
  limit?: string,
  cursor?: string,
) {
  const c = await getClient(agent);
  const params: { roomId: string; limit?: string; cursor?: string } = { roomId };
  if (limit) params.limit = limit;
  if (cursor) params.cursor = cursor;
  return c.query("space.roomy.room.getMessages", params);
}

export async function callGetMessage(agent: Agent, messageId: string) {
  const c = await getClient(agent);
  return c.query("space.roomy.message.getMessage", { messageId });
}

// ── Untyped helpers (no arktype schema yet) ───────────────────────────────
// FLAG: `space.roomy.admin.connectSpace` and `space.roomy.admin.materializeSpace`
// have no schema in packages/sdk/src/schemas/. They're left as raw `.call()`
// passthroughs until schemas are added for them.

export async function callConnectSpace(agent: Agent, did: string) {
  const c = await getClient(agent);
  const res = await c.call("space.roomy.admin.connectSpace", { did });
  return res.data;
}

export async function callMaterializeSpace(
  agent: Agent,
  did: string,
  waitBackfill: boolean,
) {
  const c = await getClient(agent);
  const params: Record<string, string> = { did };
  if (waitBackfill) params.wait = "backfill";
  const res = await c.call("space.roomy.admin.materializeSpace", params);
  return res.data;
}

// ── Generic helpers (used by the debug page NSID picker) ──────────────────

export async function callSpaceQuery(agent: Agent, nsid: string, spaceId: string) {
  const c = await getClient(agent);
  const res = await c.call(nsid, { spaceId });
  return res.data;
}

export async function callRoomQuery(agent: Agent, nsid: string, roomId: string) {
  const c = await getClient(agent);
  const res = await c.call(nsid, { roomId });
  return res.data;
}

// ── Feature flag helpers (untyped, admin-only) ──────────────────────────

export async function callGetFlags(agent: Agent) {
  const c = await getClient(agent);
  const res = await c.call("space.roomy.getFlags", {});
  return res.data as { flags: string[] };
}

export async function callAdminGetFlags(agent: Agent) {
  const c = await getClient(agent);
  const res = await c.call("space.roomy.admin.getFlags", {});
  return res.data as {
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
  flag: string,
  all?: boolean,
  userDids?: string[],
) {
  const c = await getClient(agent);
  const body: Record<string, unknown> = { flag };
  if (all !== undefined) body.all = all;
  if (userDids !== undefined) body.userDids = userDids;
  const res = await c.call("space.roomy.admin.setFlag", {}, body);
  return res.data;
}

export async function callAdminClearFlag(agent: Agent, flag: string) {
  const c = await getClient(agent);
  const res = await c.call("space.roomy.admin.clearFlag", {}, { flag });
  return res.data;
}
