import { launchConfetti } from "@fuxui/visual";
import {
  addMemberToSpace,
  joinGroupThroughInviteService,
  publicGroup,
  RoomyEntityList,
  type co,
  type RoomyAccount,
  type RoomyEntity,
} from "@roomy-chat/sdk";

export async function joinSpace(
  space: co.loaded<typeof RoomyEntity> | undefined | null,
  me: co.loaded<typeof RoomyAccount> | undefined | null,
) {
  if (!space || !me) return;

  // accept invite
  // const inviteLink = space.components?.invite;
  // // split at /
  // const inviteLinkParts = inviteLink?.split("/");
  // const organizationId = inviteLinkParts?.[0];
  // const inviteSecret = inviteLinkParts?.[1] as `inviteSecret_z${string}`;

  // if (organizationId && inviteSecret) {
  //   await me.acceptInvite(organizationId, inviteSecret, Group);
  // }

  const memberRole = space.components?.memberRole;
  await joinGroupThroughInviteService(memberRole!, me.id);

  await addMemberToSpace(me, space);

  if (me.profile && me.profile.joinedSpaces === undefined) {
    me.profile.joinedSpaces = RoomyEntityList.create([], publicGroup("reader"));
  }

  me.profile?.joinedSpaces?.push(space);

  launchConfetti();
}
