import { co, z } from "jazz-tools";
import { RoomyObject } from "./roomyobject.js";

export const Space = co.map({
  name: z.string(),

  imageUrl: z.string().optional(),

  description: z.string().optional(),

  // Uncommenting this causes the error
  members: co.list(co.account()),

  version: z.number().optional(),
  creatorId: z.string(),

  adminGroupId: z.string(),

  rootFolder: RoomyObject,

  threads: co.feed(RoomyObject),
  pages: co.list(RoomyObject),
  folders: co.list(RoomyObject),

  bans: co.list(z.string()),
});
