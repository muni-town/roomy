import { co, Group, z } from "jazz-tools";
import { RoomyEntity } from "../schema/index.js";

export async function createRoomyEntity(name: string, group: Group) {
  const entity = RoomyEntity.create(
    {
      name: name || undefined,
      components: co.record(z.string(), z.string()).create({}, group),
      softDeleted: false,
    },
    group,
  );
  return entity;
}
