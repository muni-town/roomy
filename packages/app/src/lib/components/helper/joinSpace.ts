import { launchConfetti } from "@fuxui/visual";
import {
  AllMembersComponent,
  MemberEntry,
  type co,
  type RoomyAccount,
  type RoomyEntity,
} from "@roomy-chat/sdk";

export async function joinSpace(
  space: co.loaded<typeof RoomyEntity> | undefined | null,
  me: co.loaded<typeof RoomyAccount> | undefined | null,
) {
  if (!space || !me) return;

  // add to my list of joined spaces
  me.profile?.newJoinedSpacesTest?.push(space);

  // add to space.current.members
  const membersId = space.components?.[AllMembersComponent.id];
  if (membersId) {
    const members = await AllMembersComponent.schema.load(membersId);
    members?.push(MemberEntry.create({ account: me, softDeleted: false }));
  }

  launchConfetti();
}
