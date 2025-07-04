import { Group } from "jazz-tools";

export function publicGroup(readWrite: "reader" | "writer" = "reader") {
  const group = Group.create();
  group.addMember("everyone", readWrite);

  return group;
}