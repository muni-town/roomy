import { co, z } from "jazz-tools";

export const GalleryImage = co.map({
  src: z.string(),
  name: z.string(),
  width: z.number(),
  height: z.number(),
  alt: z.string(),
});

export const GalleryContent = co.map({
  images: co.list(GalleryImage),
});