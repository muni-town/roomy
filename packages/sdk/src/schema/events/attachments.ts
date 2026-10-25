/**
 * The rows a message's attachment list writes.
 *
 * One attachment list produces reply edges, comments, media entities and their
 * embed rows, link embeds and forward edges. The `createMessage` materialiser,
 * the `editMessage` materialiser's replace branch and the appserver's message
 * projection rules all expand the same list, so the expansion lives here rather
 * than in each of them.
 */

import type { SqlStatement } from "../../types";
import { sql } from "../../utils/sqlTemplate";
import { Attachments } from "../extensions/message";
import { ensureEntity } from "./utils";

/**
 * One attachment, with its ids read as plain strings.
 *
 * The event schemas infer the extension map with its brands dropped
 * (`unionToMap`), so a materialiser receives unbranded ids even though the
 * schema constrains them to ULIDs. `Attachment` is the branded schema type and
 * is assignable to this.
 */
export type AttachmentInput =
  | { $type: "space.roomy.attachment.reply.v0"; target: string }
  | {
      $type: "space.roomy.attachment.comment.v0";
      version: string;
      snippet: string;
      from: number;
      to: number;
    }
  | {
      $type: "space.roomy.attachment.image.v0";
      uri: string;
      mimeType: string;
      alt?: string;
      height?: number;
      width?: number;
      blurhash?: string;
      size?: number;
    }
  | {
      $type: "space.roomy.attachment.video.v0";
      uri: string;
      mimeType: string;
      alt?: string;
      height?: number;
      width?: number;
      length?: number;
      blurhash?: string;
      size?: number;
    }
  | {
      $type: "space.roomy.attachment.file.v0";
      uri: string;
      mimeType: string;
      name?: string;
      size?: number;
    }
  | {
      $type: "space.roomy.attachment.link.v0";
      uri: string;
      showPreview: boolean;
    }
  | {
      $type: "space.roomy.attachment.forward.v0";
      target: string;
      fromRoomId: string;
    }
  | {
      $type: "space.roomy.attachment.tile.v0";
      uri: string;
      data?: unknown;
    };

/**
 * Statements for `attachments` on the message `messageId`.
 *
 * `streamId` is the space the rows belong to. Media entities are keyed by
 * `<uri>?message=<messageId>` and carry the message as their room, so two
 * messages embedding one URL get one row each. A forward edge is written only
 * when its target exists: a missing original (deleted before the forward, not
 * yet materialised, or cross-space) must not trip the `edges.tail` foreign key,
 * and the message is still created, just without the edge.
 */
export function attachmentStatements(
  streamId: string,
  messageId: string,
  attachments: readonly AttachmentInput[],
  /** The instant the log assigns the entry: the created/updated stamp. */
  at: number,
): SqlStatement[] {
  const statements: SqlStatement[] = [];

  for (const att of attachments) {
    switch (att.$type) {
      case "space.roomy.attachment.reply.v0":
        statements.push(sql`
          insert or ignore into edges (head, tail, label, created_at, updated_at)
          values (
            ${messageId},
            ${att.target},
            'reply',
            ${at},
            ${at}
          )
        `);
        break;

      case "space.roomy.attachment.comment.v0":
        statements.push(
          sql`
          insert into comp_comment (entity, version, snippet, idx_from, idx_to, created_at, updated_at)
          values (
            ${messageId},
            ${att.version},
            ${att.snippet || ""},
            ${att.from},
            ${att.to},
            ${at},
            ${at}
          )`,
        );
        break;

      case "space.roomy.attachment.image.v0": {
        const uriWithUlidQuery = att.uri + "?message=" + messageId;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, messageId, at),
          sql`
            insert or replace into comp_embed_image (
              entity, mime_type, alt, width, height, blurhash, size,
              created_at, updated_at
            )
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.alt},
              ${att.width ? Number(att.width) : null},
              ${att.height ? Number(att.height) : null},
              ${att.blurhash || null},
              ${att.size ? Number(att.size) : null},
              ${at},
              ${at}
            )
        `,
        );
        break;
      }

      case "space.roomy.attachment.video.v0": {
        const uriWithUlidQuery = att.uri + "?message=" + messageId;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, messageId, at),
          sql`
            insert or replace into comp_embed_video (
              entity, mime_type, alt, width, height, length, blurhash, size,
              created_at, updated_at
            )
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.alt},
              ${att.width ? Number(att.width) : null},
              ${att.height ? Number(att.height) : null},
              ${att.length ? Number(att.length) : null},
              ${att.blurhash || null},
              ${att.size ? Number(att.size) : null},
              ${at},
              ${at}
            )
        `,
        );
        break;
      }

      case "space.roomy.attachment.file.v0": {
        const uriWithUlidQuery = att.uri + "?message=" + messageId;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, messageId, at),
          sql`
            insert or replace into comp_embed_file (
              entity, mime_type, name, size, created_at, updated_at
            )
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.name || null},
              ${att.size ? Number(att.size) : null},
              ${at},
              ${at}
            )
        `,
        );
        break;
      }

      case "space.roomy.attachment.link.v0": {
        const uriWithUlidQuery = att.uri + "?message=" + messageId;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, messageId, at),
          sql`
          insert into comp_embed_link (entity, show_preview, created_at, updated_at)
          values (
            ${uriWithUlidQuery},
            ${att.showPreview ? 1 : 0},
            ${at},
            ${at}
          )
        `,
        );
        break;
      }

      case "space.roomy.attachment.tile.v0": {
        // The entity key carries the message suffix like every other embed
        // row's, but `tile_uri` holds the bare address: the read path hands
        // that straight to the client, and a tile address is a record address
        // — a `?message=` query makes it one that no longer parses.
        const uriWithUlidQuery = att.uri + "?message=" + messageId;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, messageId),
          sql`
            insert or replace into comp_embed_tile (entity, tile_uri, data)
            values (
              ${uriWithUlidQuery},
              ${att.uri},
              ${att.data === undefined ? null : JSON.stringify(att.data)}
            )
        `,
        );
        break;
      }

      case "space.roomy.attachment.forward.v0":
        statements.push(sql`
          insert or ignore into edges (head, tail, label, created_at, updated_at)
          select
            ${messageId},
            ${att.target},
            'forward',
            ${at},
            ${at}
          where exists (select 1 from entities where id = ${att.target})
        `);
        break;
    }
  }

  return statements;
}
