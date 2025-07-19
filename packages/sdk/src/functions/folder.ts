import { co, Group } from "jazz-tools";
import { createRoomyEntity } from "./roomyentity.js";
import { AllPermissions, RoomyEntity } from "../schema/index.js";
import { ChildrenComponent } from "../schema/folder.js";

export async function createFolder(
  name: string,
  permissions: Record<string, string>,
) {
  // folder doesnt need any content, it just has children
  const {
    roomyObject: folder,
    entityGroup,
    componentsGroup,
  } = await createRoomyEntity(name, permissions);

  const editEntityComponentsGroupId =
    permissions[AllPermissions.editEntityComponents]!;
  const editEntityComponentsGroup = await Group.load(
    editEntityComponentsGroupId,
  );
  entityGroup.addMember(editEntityComponentsGroup!, "writer");

  const editEntityGroupId = permissions[AllPermissions.editEntities]!;
  const editEntityGroup = await Group.load(editEntityGroupId);
  componentsGroup.addMember(editEntityGroup!, "writer");

  const publicReadGroupId = permissions[AllPermissions.publicRead]!;
  const publicReadGroup = await Group.load(publicReadGroupId);

  const childrenGroup = Group.create();
  childrenGroup.addMember(publicReadGroup!, "reader");

  const manageChildrenGroupId = permissions[AllPermissions.manageChildren]!;
  const manageChildrenGroup = await Group.load(manageChildrenGroupId);
  childrenGroup.addMember(manageChildrenGroup!, "writer");

  const children = ChildrenComponent.schema.create([], childrenGroup);

  folder.components[ChildrenComponent.id] = children.id;

  return folder;
}

export async function addToFolder(
  folder: co.loaded<typeof RoomyEntity>,
  item: co.loaded<typeof RoomyEntity>,
) {
  await folder.ensureLoaded({
    resolve: {
      components: true,
    },
  });

  const childrenId = folder.components?.[ChildrenComponent.id];

  if (childrenId) {
    const children = await ChildrenComponent.schema.load(childrenId);
    children?.push(item);
  }
}
