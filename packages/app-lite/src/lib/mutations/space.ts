import { newUlid, transport } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";
import { sendEvents } from "./send-events";

const { agentProcedure } = transport;

export async function joinSpace(
  spaceId: string,
  inviteToken?: string,
): Promise<void> {
  // Invalidation is handled by the appserver's sync signal
  // (personal.joinSpace → getSpaces invalidation via WebSocket).
  await agentProcedure(px(), "space.roomy.space.joinSpace", {
    spaceId,
    ...(inviteToken ? { inviteToken } : {}),
  });
}

export async function leaveSpace(spaceId: string): Promise<void> {
  // Invalidation is handled by the appserver's sync signal
  // (personal.leaveSpace → getSpaces invalidation via WebSocket).
  await agentProcedure(px(), "space.roomy.space.leaveSpace", {
    spaceId,
  });
}

export async function createSpace(opts: {
  name: string;
  description?: string;
  avatar?: string;
}): Promise<{ spaceId: string }> {
  // Invalidation is handled by the appserver's sync signal
  // (personal.joinSpace → getSpaces invalidation via WebSocket).
  const result = await agentProcedure(px(), "space.roomy.space.createSpace", {
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.avatar ? { avatar: opts.avatar } : {}),
  });
  return result;
}

export async function updateSpaceInfo(
  spaceId: string,
  opts: {
    name?: string;
    description?: string;
    avatar?: string;
    allowPublicJoin?: boolean;
    allowMemberInvites?: boolean;
  },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.updateSpaceInfo.v0",
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.description !== undefined && { description: opts.description }),
      ...(opts.avatar !== undefined && { avatar: opts.avatar }),
      ...(opts.allowPublicJoin !== undefined && {
        allowPublicJoin: opts.allowPublicJoin,
      }),
      ...(opts.allowMemberInvites !== undefined && {
        allowMemberInvites: opts.allowMemberInvites,
      }),
    },
  ]);
}
