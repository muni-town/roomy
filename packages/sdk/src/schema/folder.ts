import { co, z } from "jazz-tools";
import { RoomyEntity } from "./roomyentity";

export const ChildrenComponent = {
  schema: co.list(RoomyEntity),
  id: "space.roomy.children",
};
