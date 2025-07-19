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

    [AllPermissions.createThreads]: "",
    [AllPermissions.manageThreads]: "",

    [AllPermissions.editPages]: "",

    [AllPermissions.editSpace]: "",

    [AllPermissions.seeMembers]: "",
    [AllPermissions.manageMembers]: "",
  }
  for(const key in permissions) {
    const group = Group.create();
    permissions[key] = group.id;
  }

  return permissions;
}