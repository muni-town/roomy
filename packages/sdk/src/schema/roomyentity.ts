import { co, z } from "jazz-tools";

export const RoomyEntity = co.map({
  name: z.string().optional(),
  description: z.string().optional(),

  components: co.record(z.string(), z.string()),

  softDeleted: z.boolean().optional(),

  version: z.number().optional(),

  imageUrl: z.string().optional(),
});
