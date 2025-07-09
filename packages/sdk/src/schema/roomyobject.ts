import { co, z } from "jazz-tools";

export const RoomyObject = co.map({
  name: z.string(),
  description: z.string().optional(),

  components: co.record(z.string(), z.string()),

  softDeleted: z.boolean().optional(),

  creatorId: z.string().optional(),

  version: z.number().optional(),
});