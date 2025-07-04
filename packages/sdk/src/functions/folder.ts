import { Group } from "jazz-tools";
import { createRoomyObject } from "./roomyobject.ts";

export function createFolder(name: string, adminGroup: Group, allowEveryoneToAddChildren: boolean = false) {
  // folder doesnt need any content, it just has children
  const folder = createRoomyObject(name, "folder", adminGroup, allowEveryoneToAddChildren);

  return folder;
}
