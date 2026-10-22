import { transport } from "@roomy-space/sdk";
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

export interface CreateSpaceOptions {
  name: string;
  description?: string;
}

export interface SpaceInfo {
  id: string;
  name?: string;
  description?: string;
  handle?: string;
  isMember: boolean;
  isAdmin: boolean;
  /**
   * Whether any room of the space has unread messages for the caller. The
   * space list carries a level, not a count — the per-room counts come from
   * the sidebar (`rooms.ts`).
   */
  hasUnreads: boolean;
}

/**
 * Create a new Roomy space via the appserver.
 */
export async function createSpace(
  xrpc: DirectXrpcClient,
  opts: CreateSpaceOptions,
): Promise<{ spaceId: string }> {
  const result = await xrpc.procedure("space.roomy.space.createSpace", {
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
  });
  return { spaceId: result.spaceId };
}

/**
 * List all spaces the authenticated user is a member of.
 */
export async function listSpaces(
  xrpc: DirectXrpcClient,
): Promise<SpaceInfo[]> {
  const result = await xrpc.query("space.roomy.space.getSpaces", {});
  return result.spaces.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    handle: s.handle,
    isMember: s.isMember,
    isAdmin: s.isAdmin,
    hasUnreads: s.hasUnreads,
  }));
}
