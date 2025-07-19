import { Group } from "jazz-tools";
import { AllPermissions } from "../schema";

export function createPermissions() {
  const permissions: Record<string, string> = {
    [AllPermissions.publicRead]: "",

    [AllPermissions.viewMessages]: "",
    [AllPermissions.sendMessages]: "",
    [AllPermissions.deleteMessages]: "",
    [AllPermissions.editMessages]: "",
    [AllPermissions.reactToMessages]: "",
    [AllPermissions.addEmbeds]: "",
    [AllPermissions.manageEmbeds]: "",
    [AllPermissions.hideMessagesInThreads]: "",

    [AllPermissions.viewChildren]: "",
    [AllPermissions.manageChildren]: "",
    [AllPermissions.editEntities]: "",
    [AllPermissions.editEntityComponents]: "",

    [AllPermissions.createThreads]: "",
    [AllPermissions.manageThreads]: "",

    [AllPermissions.editPages]: "",

    [AllPermissions.editSpace]: "",
    [AllPermissions.addRootChildren]: "",
    [AllPermissions.editSpacePermissions]: "",

    [AllPermissions.addMembers]: "",
    [AllPermissions.seeMembers]: "",
    [AllPermissions.manageMembers]: "",

    [AllPermissions.banMembers]: "",

    [AllPermissions.manageRoles]: "",
  };
  for (const key in permissions) {
    const group = Group.create();
    permissions[key] = group.id;
  }

  return permissions;
}

export async function addRoleToPermissions(
  role: Group,
  givePermissions: string[],
  permissions: Record<string, string>,
) {
  for (const permission of givePermissions) {
    const permissionGroup = await Group.load(permissions[permission]!);
    if (!permissionGroup) {
      throw new Error("Permission group not found");
    }
    permissionGroup.addMember(role, "reader");
  }
}
