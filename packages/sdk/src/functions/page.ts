import { Group } from "jazz-tools";
import { AllPermissions, PageComponent } from "../schema/index.js";
import { createRoomyEntity } from "./roomyentity.js";

export async function createPage(
  name: string,
  permissions: Record<string, string>,
) {
  const publicReadGroupId = permissions[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicReadGroupId);

  const pageContentGroup = Group.create();
  pageContentGroup.addMember(publicReadGroup!, "reader");

  const page = PageComponent.create(
    {
      text: "",
    },
    pageContentGroup,
  );

  const { roomyObject, entityGroup, componentsGroup } = await createRoomyEntity(
    name,
    permissions,
  );

  const editEntityComponentsGroupId =
    permissions[AllPermissions.editEntityComponents]!;
  const editEntityComponentsGroup = await Group.load(
    editEntityComponentsGroupId,
  );
  entityGroup.addMember(editEntityComponentsGroup!, "writer");

  const editEntityGroupId = permissions[AllPermissions.editEntities]!;
  const editEntityGroup = await Group.load(editEntityGroupId);
  componentsGroup.addMember(editEntityGroup!, "writer");

  if (!roomyObject.components) {
    throw new Error("RoomyObject components is undefined");
  }
  roomyObject.components[PageComponent.id] = page.id;

  return { page, roomyObject };
}
