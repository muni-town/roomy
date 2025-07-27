import { Account, co, Group, z } from "jazz-tools";
import { RoomyObject } from "../schema/index.ts";
import { publicGroup } from "./group.ts";

export function createRoomyObject(name: string, adminGroup: Group) {
  const publicReadGroup = publicGroup("reader");

  const componentsGroup = publicGroup("reader");
  componentsGroup.addMember(adminGroup);

  const roomyObject = RoomyObject.create(
    {
      name,
      components: co.record(z.string(), z.string()).create({}, componentsGroup),
      creatorId: Account.getMe().id,
      softDeleted: false,
    },
    publicReadGroup,
  );

  return roomyObject;
}