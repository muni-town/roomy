/**
 * Page events: editing collaborative documents
 */

import { fromBytes } from "@atcute/cbor";
import { sql } from "../../utils";
import { type, Content, Ulid } from "../primitives";
import { defineEvent, ensureEntity } from "./utils";

const EditPageSchema = type({
  $type: "'space.roomy.page.editPage.v0'",
  body: Content.configure(
    "The edit content. \
The content can either fully replace the previous content, or if mimeType is 'text/x-dmp-diff', it's a diff-match-patch diff to apply to the previous content.",
  ),
  "previous?": Ulid.configure("ID of edit event directly preceding this one."),
}).describe(
  "Edit a page/document. The `after` value in the envelope should be the most recent previous edit. The `room` is the page ID.",
);

export const EditPage = defineEvent(
  EditPageSchema,
  ({ user, streamId, event }) => {
    if (!event.room) {
      console.warn("Edit event missing room");
      return [];
    }

    return [
      ensureEntity(streamId, event.id, event.room),
      sql`
        insert into comp_page_edits (edit_id, entity, mime_type, event, user_id)
        values (
          ${event.id},
          ${event.room},
          ${event.body.mimeType},
          ${event.body.data},
          ${user}
        )
      `,
      event.body.mimeType == "text/x-dmp-patch"
        ? sql`
          insert into comp_content (entity, mime_type, data)
          values (
            ${event.room},
            'text/markdown',
            cast(apply_dmp_patch('', ${new TextDecoder().decode(fromBytes(event.body.data))}) as blob)
          )
          on conflict do update set
            event = cast(apply_dmp_patch(cast(event as text), ${new TextDecoder().decode(fromBytes(event.body.data))}) as blob)
        `
        : sql`
          insert into comp_content (entity, mime_type, data)
          values (
            ${event.room},
            ${event.body.mimeType},
            ${event.body.data}
          )
          on conflict do update
          set
            mime_type = ${event.body.mimeType},
            event = ${event.body.data}
          where
            entity = ${event.room}
        `,
    ];
  },
  (x) => (x.previous ? [x.previous] : []),
);

// All page events
export const PageEventVariant = EditPageSchema;
