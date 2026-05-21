import { transport, cache } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";
import { queryClient } from "$lib/client";
import { sendEvents } from "./send-events";

const { agentProcedure } = transport;

export async function joinSpace(
  spaceId: string,
  inviteToken?: string,
): Promise<void> {
  await agentProcedure(px(), "space.roomy.space.joinSpace", {
    spaceId,
    ...(inviteToken ? { inviteToken } : {}),
  });
  await queryClient.invalidateQueries({
    queryKey: cache.queryKey("space.roomy.space.getSpaces"),
  });
}

export async function leaveSpace(spaceId: string): Promise<void> {
  await agentProcedure(px(), "space.roomy.space.leaveSpace", {
    spaceId,
  });
  await queryClient.invalidateQueries({
    queryKey: cache.queryKey("space.roomy.space.getSpaces"),
  });
}

export async function createSpace(opts: {
  name: string;
  description?: string;
  avatar?: string;
}): Promise<{ spaceId: string }> {
  const result = await agentProcedure(px(), "space.roomy.space.createSpace", {
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.avatar ? { avatar: opts.avatar } : {}),
  });
  await queryClient.invalidateQueries({
    queryKey: cache.queryKey("space.roomy.space.getSpaces"),
  });
  return result;
}

export async function updateSpaceInfo(
  spaceId: string,
  opts: {
    name?: string;
    desc?: string;
    avatar?: string;
    allowPublicJoin?: boolean;
    allowMemberInvites?: boolean;
  },
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: crypto.randomUUID(),
      $type: "space.roomy.space.updateSpaceInfo.v0",
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.desc !== undefined && { desc: opts.desc }),
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
