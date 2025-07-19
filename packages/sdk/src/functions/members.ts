import { Account, co, Group } from "jazz-tools";
import { AllMembersComponent, AllPermissions, MemberEntry, RoomyEntity, SpacePermissionsComponent } from "../schema";

export async function addMemberToSpace(member: Account, space: co.loaded<typeof RoomyEntity>) {
  await space.ensureLoaded({
    resolve: {
      components: {
        $each: true,
        $onError: null
      }
    }
  });

  const membersId = space.components?.[AllMembersComponent.id];
  if (!membersId) {
    throw new Error("Members component not found");
  }
  const members = await AllMembersComponent.schema.load(membersId);

  const permissions = space.components?.[SpacePermissionsComponent.id];
  if (!permissions) {
    throw new Error("Permissions component not found");
  }
  const permissionsRecord = await SpacePermissionsComponent.schema.load(permissions);
  if (!permissionsRecord) {
    throw new Error("Permissions record not found");
  }

  const memberGroup = Group.create();
  const editMembersGroupId = permissionsRecord[AllPermissions.manageMembers]!;
  const editMembersGroup = await Group.load(editMembersGroupId);
  const seeMembersGroupId = permissionsRecord[AllPermissions.seeMembers]!;
  const seeMembersGroup = await Group.load(seeMembersGroupId);
  memberGroup.addMember(editMembersGroup!, "writer");
  memberGroup.addMember(seeMembersGroup!, "reader");

  const me = MemberEntry.create(
    {
      account: member,
      softDeleted: false,
    },
    memberGroup,
  );
  
  members?.push(me);
}