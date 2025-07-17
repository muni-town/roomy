import { co, Group } from "jazz-tools";
import { PageContent } from "../schema/index.js";
import { publicGroup } from "./group.js";
import { createRoomyObject } from "./roomyobject.js";

export function createPage(name: string, adminGroup: Group) {
  const readingGroup = publicGroup();
  readingGroup.addMember(adminGroup);

  const page = PageContent.create(
    {
      text: "",
      //editableText: co.richText().create("", readingGroup),
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
