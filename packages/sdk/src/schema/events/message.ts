/**
 * Message events: create, edit, delete, move, reorder
 */

import { type, Ulid, Content } from "../primitives";
import {
  MessageExtensionMap,
  MessageExtensionUpdateMap,
} from "../extensions/message";
import { defineEvent, ensureEntity } from "./utils";
import { sql } from "../../utils";
import { decodeTime } from "ulidx";
import { fromBytes } from "@atcute/cbor";

const CreateMessageSchema = type({
  $type: "'space.roomy.message.createMessage.v0'",
  body: Content.describe(
    "The main content of the chat message. Usually this uses the text/markdown mime type.",
  ),
  extensions: MessageExtensionMap,
}).describe("Create a new message.");

export const CreateMessage = defineEvent(
  CreateMessageSchema,
  ({ streamId, user, event }) => {
    if (!event.room) throw new Error("No room for message");
    const statements = [
      ensureEntity(streamId, event.id, event.room),
      sql`
        insert or replace into comp_content (entity, mime_type, data, last_edit)
        values (
          ${event.id},
          ${event.body.mimeType},
          ${(event.body.data as { buf: Uint8Array }).buf},
          ${event.id}
        )`,
      sql`
        insert into comp_last_read (entity, timestamp, unread_count)
          values (${event.room}, 1, 1)
          on conflict(entity) do update set
            unread_count = case
              when ${decodeTime(event.id)} > comp_last_read.timestamp
              then comp_last_read.unread_count + 1
              else comp_last_read.unread_count
            end,
            updated_at = (unixepoch() * 1000)
      `,
    ];

    // Handle overrideAuthorDid, overrideTimestamp extensions
    const overrideAuthorExt =
      event.extensions["space.roomy.extension.authorOverride.v0"]?.did;
    const overrideTimestampExt =
      event.extensions["space.roomy.extension.timestampOverride.v0"]?.timestamp;

    if (!overrideAuthorExt) {
      // normal messages - create 'author' edge
      statements.push(sql`
        insert or replace into edges (head, tail, label)
        select
          ${event.id},
          ${user},
          'author'
      `);
    } else {
      // for bridged messages, use the overridden author, not the actual one
      statements.push(ensureEntity(streamId, overrideAuthorExt));
      statements.push(sql`
        insert or replace into edges (head, tail, label)
        select
          ${event.id},
          ${overrideAuthorExt},
          'author'
      `);
    }

    if (overrideAuthorExt || overrideTimestampExt) {
      statements.push(sql`
        insert or replace into comp_override_meta (entity, author, timestamp)
        values (
          ${event.id},
          ${overrideAuthorExt ? overrideAuthorExt : null},
          ${overrideTimestampExt ? Number(overrideTimestampExt) : null}
        )
      `);
    }

    for (const att of event.extensions["space.roomy.extension.attachments.v0"]
      ?.attachments || []) {
      if (att.$type == "space.roomy.attachment.reply.v0") {
        statements.push(sql`
          insert or ignore into edges (head, tail, label)
          values (
            ${event.id},
            ${att.target},
            'reply'
          )
        `);
      } else if (att.$type == "space.roomy.attachment.comment.v0") {
        statements.push(
          sql`
          insert into comp_comment (entity, version, snippet, idx_from, idx_to, updated_at)
          values (
            ${event.id},
            ${att.version},
            ${att.snippet || ""},
            ${att.from},
            ${att.to},
            (unixepoch() * 1000)
          )`,
        );
      } else if (att.$type == "space.roomy.attachment.image.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
            insert or replace into comp_embed_image (entity, mime_type, alt, width, height, blurhash, size)
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.alt},
              ${att.width ? Number(att.width) : null},
              ${att.height ? Number(att.height) : null},
              ${att.blurhash || null},
              ${att.size ? Number(att.size) : null}
            )
        `,
        );
      } else if (att.$type == "space.roomy.attachment.video.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
            insert or replace into comp_embed_video (entity, mime_type, alt, width, height, length, blurhash, size)
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.alt},
              ${att.width ? Number(att.width) : null},
              ${att.height ? Number(att.height) : null},
              ${att.length ? Number(att.length) : null},
              ${att.blurhash || null},
              ${att.size ? Number(att.size) : null}
            )
        `,
        );
      } else if (att.$type == "space.roomy.attachment.file.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
            insert or replace into comp_embed_file (entity, mime_type, name, size)
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.name || null},
              ${att.size ? Number(att.size) : null}
            )
        `,
        );
      } else if (att.$type == "space.roomy.attachment.link.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
          insert into comp_embed_link (entity, show_preview)
          values (
            ${uriWithUlidQuery},
            ${att.showPreview ? 1 : 0}
          )
        `,
        );
      }
    }

    return statements;
  },
);

const EditMessageSchema = type({
  $type: "'space.roomy.message.editMessage.v0'",
  messageId: Ulid.describe("ID of message being edited."),
  "previous?": Ulid.describe("ID of edit event directly preceding this one."),
  body: Content.describe(
    "New content. \
If mimeType is text/x-dmp-diff, this is a diff-match-patch diff to apply to the previous content.",
  ),
  "extensions?": MessageExtensionUpdateMap,
}).describe("Edit a previously sent message.");

export const EditMessage = defineEvent(
  EditMessageSchema,
  ({ streamId, event }) => {
    if (!event.room) {
      console.warn("Edit event missing room");
      return [];
    }

    // TODO: fix the issue wehre we have to manually cast event.body.data

    const statements = [
      ensureEntity(streamId, event.id, event.room),
      event.body.mimeType == "text/x-dmp-patch"
        ? sql`
          update comp_content
          set
            data = cast(apply_dmp_patch(cast(data as text), ${new TextDecoder().decode((event.body.data as { buf: Uint8Array }).buf)}) as blob),
            last_edit = ${event.id}
          where
            entity = ${event.messageId}
              and
            mime_type like 'text/%'
        `
        : sql`
          update comp_content
          set
            mime_type = ${event.body.mimeType},
            data = ${fromBytes(event.body.data)},
            last_edit = ${event.id}
          where
            entity = ${event.messageId}
        `,
    ];

    // Handle attachments extension updates
    // null = remove all attachments, value = replace attachments
    if (
      event.extensions &&
      "space.roomy.extension.attachments.v0" in event.extensions
    ) {
      const attachmentsExt =
        event.extensions["space.roomy.extension.attachments.v0"];

      // Delete existing attachment data for this message
      // Pattern: entity ends with ?message=<messageId>
      const messageIdSuffix = `%?message=${event.messageId}`;
      statements.push(
        sql`delete from comp_embed_image where entity like ${messageIdSuffix}`,
        sql`delete from comp_embed_video where entity like ${messageIdSuffix}`,
        sql`delete from comp_embed_file where entity like ${messageIdSuffix}`,
        sql`delete from comp_embed_link where entity like ${messageIdSuffix}`,
        sql`delete from comp_comment where entity = ${event.messageId}`,
        sql`delete from edges where head = ${event.messageId} and label = 'reply'`,
        // Clean up orphaned entities (media entities have room = messageId)
        sql`delete from entities where room = ${event.messageId} and id != ${event.messageId}`,
      );

      // If new attachments provided (not null/undefined), insert them
      if (attachmentsExt != null) {
        for (const att of attachmentsExt.attachments || []) {
          if (att.$type == "space.roomy.attachment.reply.v0") {
            statements.push(sql`
              insert or ignore into edges (head, tail, label)
              values (
                ${event.messageId},
                ${att.target},
                'reply'
              )
            `);
          } else if (att.$type == "space.roomy.attachment.comment.v0") {
            statements.push(
              sql`
              insert into comp_comment (entity, version, snippet, idx_from, idx_to, updated_at)
              values (
                ${event.messageId},
                ${att.version},
                ${att.snippet || ""},
                ${att.from},
                ${att.to},
                (unixepoch() * 1000)
              )`,
            );
          } else if (att.$type == "space.roomy.attachment.image.v0") {
            const uriWithUlidQuery = att.uri + "?message=" + event.messageId;
            statements.push(
              ensureEntity(streamId, uriWithUlidQuery, event.messageId),
              sql`
                insert or replace into comp_embed_image (entity, mime_type, alt, width, height, blurhash, size)
                values (
                  ${uriWithUlidQuery},
                  ${att.mimeType},
                  ${att.alt},
                  ${att.width ? Number(att.width) : null},
                  ${att.height ? Number(att.height) : null},
                  ${att.blurhash || null},
                  ${att.size ? Number(att.size) : null}
                )
            `,
            );
          } else if (att.$type == "space.roomy.attachment.video.v0") {
            const uriWithUlidQuery = att.uri + "?message=" + event.messageId;
            statements.push(
              ensureEntity(streamId, uriWithUlidQuery, event.messageId),
              sql`
                insert or replace into comp_embed_video (entity, mime_type, alt, width, height, length, blurhash, size)
                values (
                  ${uriWithUlidQuery},
                  ${att.mimeType},
                  ${att.alt},
                  ${att.width ? Number(att.width) : null},
                  ${att.height ? Number(att.height) : null},
                  ${att.length ? Number(att.length) : null},
                  ${att.blurhash || null},
                  ${att.size ? Number(att.size) : null}
                )
            `,
            );
          } else if (att.$type == "space.roomy.attachment.file.v0") {
            const uriWithUlidQuery = att.uri + "?message=" + event.messageId;
            statements.push(
              ensureEntity(streamId, uriWithUlidQuery, event.messageId),
              sql`
                insert or replace into comp_embed_file (entity, mime_type, name, size)
                values (
                  ${uriWithUlidQuery},
                  ${att.mimeType},
                  ${att.name || null},
                  ${att.size ? Number(att.size) : null}
                )
            `,
            );
          } else if (att.$type == "space.roomy.attachment.link.v0") {
            const uriWithUlidQuery = att.uri + "?message=" + event.messageId;
            statements.push(
              ensureEntity(streamId, uriWithUlidQuery, event.messageId),
              sql`
              insert into comp_embed_link (entity, show_preview)
              values (
                ${uriWithUlidQuery},
                ${att.showPreview ? 1 : 0}
              )
            `,
            );
          }
        }
      }
    }

    return statements;
  },
  (x) => (x.previous ? [x.previous, x.messageId] : [x.messageId]),
);

const DeleteMessageSchema = type({
  $type: "'space.roomy.message.deleteMessage.v0'",
  messageId: Ulid.describe("The ID of the message being deleted."),
  "reason?": "string",
}).describe("Delete a message.");

export const DeleteMessage = defineEvent(
  DeleteMessageSchema,
  ({ event }) => {
    if (!event.room) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [sql`delete from entities where id = ${event.messageId}`];
  },
  (x) => [x.messageId],
);

const MoveMessagesSchema = type({
  $type: "'space.roomy.message.moveMessages.v0'",
  messageIds: Ulid.array()
    .moreThanLength(0)
    .atMostLength(1) // Must be exactly one until we have TVFs in LibSQL
    .describe("The IDs of the messages being moved."),
  toRoomId: Ulid.describe("The room to which the messages should be moved"),
}).describe("Move one or more messages to a different room");

export const MoveMessages = defineEvent(
  MoveMessagesSchema,
  ({ event }) => {
    return event.messageIds.map(
      (msgId) =>
        sql`
          update entities set room = ${event.toRoomId}
          where id = ${msgId}
        `,
    );
  },
  (x) => [...x.messageIds],
);

const ReorderMessageSchema = type({
  $type: "'space.roomy.message.reorderMessage.v0'",
  messageId: Ulid.describe("The ID of the message being moved."),
  after: Ulid.describe(
    "The ID of the message that should directly precede this one",
  ),
}).describe("Reorder a message in a room's timeline");

export const ReorderMessage = defineEvent(
  ReorderMessageSchema,
  // Note: reorder is handled interactively in the worker
  ({}) => [],
  (x) => [x.messageId],
);

const ForwardMessagesSchema = type({
  $type: "'space.roomy.message.forwardMessages.v0'",
  messageIds: Ulid.array()
    .moreThanLength(0)
    .atMostLength(1) // Must be exactly one until we have TVFs in LibSQL
    .describe("The IDs of the messages being forwarded."),
  fromRoomId: Ulid.describe(
    "The room from which the messages are being forwarded",
  ),
}).describe(
  "Forward one or more messages to a different room. Unlike move, the original messages remain in place.",
);

export const ForwardMessages = defineEvent(
  ForwardMessagesSchema,
  ({ streamId, event }) => {
    if (!event.room) {
      console.warn("Forward event missing room");
      return [];
    }
    // For each forwarded message, create a "forward" edge in the destination room
    // The forwarded message appears in event.room with a reference back to the original
    // event.fromRoomId indicates where the message originated
    // event.id serves as the forward reference entity ULID
    return event.messageIds.flatMap((msgId) => [
      // Ensure the forwarded reference entity exists in the target (destination) room
      ensureEntity(streamId, event.id, event.room),
      // Create forward edge: head = forward reference (event.id), tail = original message
      sql`
        insert or ignore into edges (head, tail, label)
        values (
          ${event.id},
          ${msgId},
          'forward'
        )
      `,
    ]);
  },
  (x) => [x.id, ...x.messageIds],
);

// All message events
export const MessageEventVariant = type.or(
  CreateMessageSchema,
  EditMessageSchema,
  DeleteMessageSchema,
  MoveMessagesSchema,
  ReorderMessageSchema,
  ForwardMessagesSchema,
);
