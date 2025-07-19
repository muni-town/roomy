import { co, z } from "jazz-tools";

export const PageContent = co.map({
  text: z.string(),
});

export const PageComponent = {
  schema: PageContent,
  id: "space.roomy.page.v0",
};