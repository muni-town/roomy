import { co, Group } from "jazz-tools";
import { createRoomyObject } from "./roomyobject.js";
import { RoomyEntity } from "../schema/index.js";
import { ChildrenComponent } from "../schema/folder.js";

export async function createFolder(name: string, permissions: Record<string, string>) {
  // folder doesnt need any content, it just has children
  const {roomyObject: folder, entityGroup, componentsGroup} = await createRoomyObject(name, permissions);

  const publicReadGroupId = permissions.publicRead!;
  const publicReadGroup = await Group.load(publicReadGroupId);

  const childrenGroup = Group.create();
  childrenGroup.addMember(publicReadGroup!);

  const children = ChildrenComponent.schema.create([], childrenGroup);

  folder.components[ChildrenComponent.id] = children.id;

  return folder;
}

export async function addToFolder(folder: co.loaded<typeof RoomyEntity>, item: co.loaded<typeof RoomyEntity>) {
  await folder.ensureLoaded({
    resolve: {
      components: true
    }
  });
  
  const childrenId = folder.components?.[ChildrenComponent.id];

  if (childrenId) {
    const children = await ChildrenComponent.schema.load(childrenId);
    children?.push(item);
  }
}