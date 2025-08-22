import { co, z } from "jazz-tools";
import { defComponent, RoomyEntity } from "./roomyentity.js";

export const ChildrenComponent = defComponent(
  "space.roomy.children",
  co.list(RoomyEntity),
);

export const ParentComponent = {
  id: "space.roomy.parent",
};
