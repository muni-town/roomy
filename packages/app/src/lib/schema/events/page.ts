/**
 * Page events: editing collaborative documents
 */

import { type, Content, Ulid } from "../primitives";

/**
 * Edit a page/document.
 *
 * The content can either fully replace the previous content,
 * or if mimeType is "text/x-dmp-diff", it's a diff-match-patch
 * diff to apply to the previous content.
 */
export const pageEdit = type({
  $type: "'space.roomy.room.editPage.v0'",
  /** Previous edit event unless this is the first. */
  "previous?": Ulid,
  /** The edit content (full replacement or diff) */
  body: Content,
});

// All page events
export const pageEvent = pageEdit;

// Export for registry
export const events = {
  "space.roomy.room.editPage.v0": {
    type: pageEdit,
    description:
      "Edit a page document (full replacement or diff-match-patch diff)",
  },
} as const;
