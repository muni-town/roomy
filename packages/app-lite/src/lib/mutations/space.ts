import { newUlid } from "@roomy-space/sdk";
import { sendEvents } from "./send-events";

export async function joinSpace(
  spaceId: string,
  inviteToken?: string,
): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.joinSpace.v0",
      ...(inviteToken ? { inviteToken } : {}),
    },
  ]);
}

export async function leaveSpace(spaceId: string): Promise<void> {
  await sendEvents(spaceId, [
    {
      id: newUlid(),
      $type: "space.roomy.space.leaveSpace.v0",
    },
  ]);
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
