import { Account, co, Group } from "jazz-tools";
import { RoomyEntity } from "../schema";
import { getSpaceGroups } from "./space";

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

export async function isSpaceAdmin(
  account: Account,
  space: co.loaded<typeof RoomyEntity>,
): Promise<boolean> {
  const { admin } = await getSpaceGroups(space);

  return !!admin.members.find(
    (x) => x.id == account.id && (x.role == "writer" || x.role == "admin"),
  );
}

/**
 * Grants full write access for the account to the space. This is useful for granting maximum space
 * access to things like the Discord bot. This does not add any Jazz group `admin` permission
 * though, so it can be revoked. */
export async function makeSpaceAdmin(
  account: Account,
  space: co.loaded<typeof RoomyEntity>,
) {
  const { admin } = await getSpaceGroups(space);
  admin.addMember(account, "writer");
}

/** Revokes all write permissions. Essentially the opposite of `grantFullWritePermissions`. */
export async function revokeSpaceAdmin(
  account: Account,
  space: co.loaded<typeof RoomyEntity>,
) {
  const { admin } = await getSpaceGroups(space);
  await admin.removeMember(account);
}
