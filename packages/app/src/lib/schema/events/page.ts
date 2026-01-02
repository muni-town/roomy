/**
 * Page events: editing collaborative documents
 */

import { type, Content } from "../primitives";
import { setDependsOn } from "./dependencies";

export const EditPage = type({
  $type: "'space.roomy.page.editPage.v0'",
  body: Content.configure(
    "The edit content. \
The content can either fully replace the previous content, or if mimeType is 'text/x-dmp-diff', it's a diff-match-patch diff to apply to the previous content.",
  ),
}).describe(
  "Edit a page/document. The `after` value in the envelope should be the most recent previous edit. The `room` is the page ID.",
);

setDependsOn("space.roomy.page.editPage.v0", {
  dependsOnAfter: true,
});

// All page events
export const PageEvent = EditPage;
