import { co, Group } from "jazz-tools";
import { GalleryContent, GalleryImage } from "../schema/index.ts";
import { publicGroup } from "./group.ts";
import { createRoomyObject } from "./roomyobject.ts";

export function createGallery(name: string, adminGroup: Group) {
  const readingGroup = publicGroup();
  readingGroup.addMember(adminGroup);

  const gallery = GalleryContent.create(
    {
      images: co.list(GalleryImage).create([], readingGroup),
    },
    readingGroup,
  );

  const roomyObject = createRoomyObject(name, adminGroup);

  if (!roomyObject.components) {
    throw new Error("RoomyObject components is undefined");
  }
  roomyObject.components.gallery = gallery.id;

  return { page: gallery, roomyObject };
}
