import { Group } from "jazz-tools";
import { PageComponent } from "../schema/index.js";
import { createRoomyObject } from "./roomyobject.js";

export async function createPage(name: string, permissions: Record<string, string>) {
  const publicReadGroupId = permissions.publicRead;
  const publicReadGroup = await Group.load(publicReadGroupId!);

  const pageContentGroup = Group.create();
  pageContentGroup.addMember(publicReadGroup!);

  const page = PageComponent.schema.create(
    {
      text: "",
    },
    pageContentGroup,
  );

  const {roomyObject, entityGroup, componentsGroup} = await createRoomyObject(name, permissions);

  if (!roomyObject.components) {
    throw new Error("RoomyObject components is undefined");
  }
  roomyObject.components[PageComponent.id] = page.id;

  return { page, roomyObject };
}
