import { Group } from "jazz-tools";
import { PageContent } from "../schema/index.ts";
import { publicGroup } from "./group.ts";
import { createRoomyObject } from "./roomyobject.ts";

export function createPage(name: string, adminGroup: Group) {
  const readingGroup = publicGroup();

  const page = PageContent.create(
    {
      body: "",
    },
    readingGroup,
  );

  const roomyObject = createRoomyObject(name, adminGroup);

  if (!roomyObject.content) {
    throw new Error("RoomyObject content is undefined");
  }
  roomyObject.content.page = page.id;

  return page;
}
