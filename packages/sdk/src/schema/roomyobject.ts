import { co, z } from "jazz-tools";

export const RoomyObject = co.map({
  content: z.optional(co.record(z.string(), z.string())),

  name: z.string(),

  parentId: z.string().optional(),

  childrenIds: co.list(z.string()),

  softDeleted: z.boolean().optional(),

  createdAt: z.date(),
  updatedAt: z.date(),

  creatorId: z.string(),
});