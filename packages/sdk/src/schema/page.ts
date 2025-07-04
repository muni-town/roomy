import { co, z } from "jazz-tools";

export const PageContent = co.map({
  body: z.string(),
});