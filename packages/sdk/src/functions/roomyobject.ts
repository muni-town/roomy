import { Account, co, Group, z } from "jazz-tools";
import { RoomyObject } from "../schema/index.ts";
import { publicGroup } from "./group.ts";

export function createRoomyObject(name: string, objectType: "thread" | "page" | "folder", adminGroup: Group, allowChildrenWrite: boolean = false) {
  const publicReadGroup = publicGroup("reader");

  const addChildrenGroup = publicGroup(allowChildrenWrite ? "writer" : "reader");
  addChildrenGroup.extend(adminGroup);

  const roomyObject = RoomyObject.create(
    {
      name,
      objectType,
      childrenIds: co.list(z.string()).create([], addChildrenGroup),
      createdAt: new Date(),
      updatedAt: new Date(),
      creatorId: Account.getMe().id,
    },
    publicReadGroup,
  );

  return roomyObject;
}