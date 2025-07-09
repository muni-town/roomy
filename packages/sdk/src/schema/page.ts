import { co, z } from "jazz-tools";

export const PageContent = co.map({
  text: z.string(),

  editableText: co.richText(),
});