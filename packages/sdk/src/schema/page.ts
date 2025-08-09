import { co, z } from "jazz-tools";
import { defComponent } from "./roomyentity";

export const PageContent = co.map({
  text: z.string(),
});

export const PageComponent = defComponent("space.roomy.page.v0", PageContent);
