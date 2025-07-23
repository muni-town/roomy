import { co, z } from "jazz-tools";

export const UploadMedia = co.map({
  path: z.string(),
  mediaType: z.enum(["image", "video"]),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  attachToMessageId: z.string().optional(),
});

export const MediaUploadQueue = co.list(UploadMedia);
