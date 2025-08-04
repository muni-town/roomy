import { co, Group, z } from "jazz-tools";
import { AllPermissions, RoomyEntity } from "../schema/index.js";

export async function createRoomyEntity(
  name: string,
  permissions: Record<string, string>,
) {
  const publicReadGroupId = permissions[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicReadGroupId);

  const entityGroup = Group.create();
  entityGroup.addMember(publicReadGroup!, "reader");

  const componentsGroup = Group.create();
  componentsGroup.addMember(publicReadGroup!, "reader");

  const roomyObject = RoomyEntity.create(
    {
      name: name || undefined,
      components: co.record(z.string(), z.string()).create({}, componentsGroup),
      softDeleted: false,
    },
    entityGroup,
  );

  return { roomyObject, entityGroup, componentsGroup };
}
