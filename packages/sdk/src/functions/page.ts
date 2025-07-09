import { co, Group } from "jazz-tools";
import { PageContent } from "../schema/index.ts";
import { publicGroup } from "./group.ts";
import { createRoomyObject } from "./roomyobject.ts";

export function createPage(name: string, adminGroup: Group) {
  const readingGroup = publicGroup();
  readingGroup.addMember(adminGroup);

  const page = PageContent.create(
    {
      text: "",
      editableText: co.richText().create("", readingGroup),
    },
    readingGroup,
  );

  const roomyObject = createRoomyObject(name, adminGroup);

  if (!roomyObject.components) {
    throw new Error("RoomyObject components is undefined");
  }
  roomyObject.components.page = page.id;

  return { page, roomyObject };
}
