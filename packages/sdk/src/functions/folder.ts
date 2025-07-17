import { co, Group } from "jazz-tools";
import { createRoomyObject } from "./roomyobject.js";
import { IDList, RoomyObject } from "../schema/index.js";
import { publicGroup } from "./group.js";

export function createFolder(name: string, adminGroup: Group, allowEveryoneToAddChildren: boolean = false) {
  // folder doesnt need any content, it just has children
  const folder = createRoomyObject(name, adminGroup);

  const addChildrenGroup = publicGroup(allowEveryoneToAddChildren ? "writer" : "reader");
  addChildrenGroup.addMember(adminGroup);

  const children = IDList.create([], addChildrenGroup);

  folder.components['children'] = children.id;

  return folder;
}


export async function addToFolder(folder: co.loaded<typeof RoomyObject>, item: co.loaded<typeof RoomyObject>) {
  const childrenId = folder.components?.children;

  if (childrenId) {
    const children = await IDList.load(childrenId);
    children?.push(item.id);
  }
}