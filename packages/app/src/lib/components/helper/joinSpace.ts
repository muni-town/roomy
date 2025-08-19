import { launchConfetti } from "@fuxui/visual";
import {
  publicGroup,
  RoomyEntityList,
  addMemberToSpace,
  type co,
  type RoomyAccount,
  type RoomyEntity,
  getSpaceGroups,
} from "@roomy-chat/sdk";
import { joinGroupThroughInviteService } from "@roomy-chat/sdk/utils/invites";

export async function joinSpace(
  space: co.loaded<typeof RoomyEntity> | undefined | null,
  me: co.loaded<typeof RoomyAccount> | undefined | null,
) {
  if (!space || !me) return;

  const groups = await getSpaceGroups(space);
  await joinGroupThroughInviteService(groups.public.id, me.id);

  await addMemberToSpace(me, space);

  if (me.profile && me.profile.joinedSpaces === undefined) {
    me.profile.joinedSpaces = RoomyEntityList.create([], publicGroup("reader"));
  }

  me.profile?.joinedSpaces?.push(space);

  launchConfetti();
}
