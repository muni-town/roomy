import { Account, co, Group } from "jazz-tools";
import {
  AllPermissions,
  RoomyEntity,
  SpacePermissionsComponent,
} from "../schema";

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

export async function hasFullWritePermissions(
  account: Account,
  space: co.loaded<typeof RoomyEntity>,
): Promise<boolean> {
  const permissionsId = space.components?.[SpacePermissionsComponent.id];
  if (!permissionsId) throw new Error("Space permissions component missing");
  const permissions = await SpacePermissionsComponent.load(permissionsId);
  if (!permissions) throw new Error("Space permissions component missing");

  for (const permId of Object.values(AllPermissions)) {
    const permGroupId = permissions[permId];
    if (!permGroupId) continue;
    const perm = await Group.load(permGroupId);
    if (!perm) throw new Error("Error loading permissions group");
    if (!perm.members.find((x) => x.id == account.id && x.role == "writer")) {
      return false;
    }
  }

  return true;
}

/**
 * Grants full write access for the account to the space. This is useful for granting maximum space
 * access to things like the Discord bot. This does not add any Jazz group `admin` permission
 * though, so it can be revoked. */
export async function grantFullWritePermissions(
  account: Account,
  space: co.loaded<typeof RoomyEntity>,
) {
  const permissionsId = space?.components?.[SpacePermissionsComponent.id];
  if (!permissionsId) throw new Error("Space permissions component missing");
  const permissions = await SpacePermissionsComponent.load(permissionsId);
  if (!permissions) throw new Error("Space permissions component missing");

  for (const permId of Object.values(AllPermissions)) {
    const permGroupId = permissions[permId];
    if (!permGroupId) continue;
    const perm = await Group.load(permGroupId);
    if (!perm) throw new Error("Error loading permissions group");
    if (!perm.members.find((x) => x.id == account.id)) {
      perm.addMember(account, "writer");
    }
  }
}

/** Revokes all write permissions. Essentially the opposite of `grantFullWritePermissions`. */
export async function revokeFullWritePermissions(
  account: Account,
  space: co.loaded<typeof RoomyEntity>,
) {
  const permissionsId = space?.components?.[SpacePermissionsComponent.id];
  if (!permissionsId) throw new Error("Space permissions component missing");
  const permissions = await SpacePermissionsComponent.load(permissionsId);
  if (!permissions) throw new Error("Space permissions component missing");

  for (const permId of Object.values(AllPermissions)) {
    const permGroupId = permissions[permId];
    if (!permGroupId) continue;
    const perm = await Group.load(permGroupId);
    if (!perm) throw new Error("Error loading permissions group");

    if (perm.members.find((x) => x.id == account.id)) {
      perm.removeMember(account);
    }
  }
}
