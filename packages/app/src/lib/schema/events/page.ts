/**
 * Page events: editing collaborative documents
 */

import { type, Content, Ulid } from "../primitives";

export const EditPage = type({
  $type: "'space.roomy.page.editPage.v0'",
  "previous?": Ulid.configure(
    "Previous edit event or undefined if this is the first.",
  ),
  body: Content.configure(
    "The edit content. \
The content can either fully replace the previous content, or if mimeType is 'text/x-dmp-diff', it's a diff-match-patch diff to apply to the previous content.",
  ),
}).describe("Edit a page/document.");

// All page events
export const PageEvent = EditPage;
