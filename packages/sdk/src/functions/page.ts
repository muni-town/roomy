import { Group } from "jazz-tools";
import { addComponent, PageComponent } from "../schema/index.js";
import { createRoomyEntity } from "./roomyentity.js";

export async function createPage(name: string, group: Group) {
  const entity = await createRoomyEntity(name, group);

  const page = addComponent(entity, PageComponent, { text: "" }, group);

  return { page, entity };
}
