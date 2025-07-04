import { co, z } from "jazz-tools";

export const RoomyObject = co.map({
  objectType: z.enum(["thread", "page", "folder"]),

  contentId: z.string().optional(),

  name: z.string(),

  parentId: z.string().optional(),

  childrenIds: co.list(z.string()),

  softDeleted: z.boolean().optional(),

  createdAt: z.date(),
  updatedAt: z.date(),

  creatorId: z.string(),
});