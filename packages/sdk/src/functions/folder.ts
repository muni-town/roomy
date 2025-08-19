import { co, Group } from "jazz-tools";
import { createRoomyEntity } from "./roomyentity.js";
import { addComponent, RoomyEntity } from "../schema/index.js";
import { ChildrenComponent, ParentComponent } from "../schema/folder.js";

export async function createFolder(
  name: string,
  group: Group,
): Promise<{
  entity: co.loaded<typeof RoomyEntity>;
  children: co.loaded<typeof ChildrenComponent>;
}> {
  const entity = await createRoomyEntity(name, group);
  const children = await addComponent(entity, ChildrenComponent, [], group);

  return { entity, children };
}

export async function addToFolder(
  folder: co.loaded<typeof RoomyEntity>,
  item: co.loaded<typeof RoomyEntity>,
  atIndex?: number,
) {
  await folder.ensureLoaded({
    resolve: {
      components: true,
    },
  });

  await item.ensureLoaded({
    resolve: {
      components: true,
    },
  });

  const childrenId = folder.components?.[ChildrenComponent.id];

  if (childrenId && item.components) {
    const children = await ChildrenComponent.load(childrenId);
    if (atIndex !== undefined && atIndex >= 0) {
      children?.splice(atIndex, 0, item);
    } else {
      children?.push(item);
    }

    // add parentId to item
    item.components[ParentComponent.id] = folder.id;
  } else {
    const children = ChildrenComponent.create([item]);
    folder.components![ChildrenComponent.id] = children.id;
    item.components![ParentComponent.id] = folder.id;
  }
}

export async function removeFromFolder(
  folder: co.loaded<typeof RoomyEntity>,
  item: co.loaded<typeof RoomyEntity>,
) {
  await folder.ensureLoaded({
    resolve: {
      components: true,
    },
  });

  await item.ensureLoaded({
    resolve: {
      components: true,
    },
  });

  const childrenId = folder.components?.[ChildrenComponent.id];

  if (!folder.components || !item.components) {
    throw new Error("Folder or item components not found");
  }

  if (childrenId) {
    const children = await ChildrenComponent.load(childrenId);

    const index = children?.findIndex((x) => x?.id === item.id);

    if (index !== undefined && index >= 0) {
      children?.splice(index, 1);
      delete item.components[ParentComponent.id];
    }
  } else {
    throw new Error("Folder or item components not found");
  }
}
