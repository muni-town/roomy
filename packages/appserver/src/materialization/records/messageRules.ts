/**
 * Projection rules for the `message` record kind.
 *
 * Each rule takes one change and returns the statements that apply it to the
 * per-space DB: `create` and `update` are upserts, `delete` is a removal from
 * the set. A rule reads the record body plus the state the caller passes in the
 * context, never the log entry that produced the change.
 *
 * Two things the event materialisers do are deliberately not rules. A
 * `deleteMessage` is a removal from the message set, and the state that
 * remembered the message — the room's `activity_item` window — is recomputed
 * from the rows that remain by the caller (`deleteMessage.ts`,
 * `roomDerivedState.ts`), so no rule records that a deletion happened. An
 * `editMessage` replaces the content with the body the record carries: the
 * materialiser's `apply_dmp_patch` branch is not carried over, because nothing
 * produces a `text/x-dmp-patch` body and no such SQL function exists.
 */

import {
  type AttachmentInput,
  type SqlStatement,
  type StreamDid,
  type Ulid,
  attachmentStatements,
  ensureEntity,
  sql,
} from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

import type { ChangeOf, Rkey } from "./recordChange.ts";
import type { MessageRecord } from "./recordKinds.ts";

/** The extension an attachment list is carried under. */
const ATTACHMENTS = "space.roomy.extension.attachments.v0";

/** The extension a bridged message carries its canonical send time under. */
const TIMESTAMP_OVERRIDE = "space.roomy.extension.timestampOverride.v0";

/** One `message` change, narrowed to the kind. */
export type MessageChange = ChangeOf<"message">;

/** What a message rule needs from the batch that the record does not carry. */
export interface MessageRuleContext {
  /** The space the record belongs to. */
  readonly streamId: StreamDid;
  /**
   * The room the message was in before this change. A move names only its
   * destination and a delete names no room at all, so the rule that rebuilds
   * the room it left gets it from here.
   */
  readonly priorRoom?: string;
}

/**
 * The statements that apply one `message` change.
 *
 * Ordered: the message's own rows first, then what hangs off it, then its
 * ordering key — the order the event path writes them in.
 */
export function messageStatements(
  change: MessageChange,
  ctx: MessageRuleContext,
): SqlStatement[] {
  switch (change.op) {
    case "create":
      return createStatements(change, ctx);
    case "update":
      return updateStatements(change, ctx);
    case "delete":
      return deleteStatements(change);
  }
}

/** A create is a message with content, or a forward reference with neither. */
function createStatements(
  change: Extract<MessageChange, { op: "create" }>,
  ctx: MessageRuleContext,
): SqlStatement[] {
  const record = change.record;
  const id = change.rkey;

  if (record.system !== undefined) {
    // A system message is rendered from projection state (the linked room's
    // name) and arrives only from `createRoomLink`, whose `room` change writes
    // the link edge that names the linking room. It carries no ordering key of
    // its own — the event path never stamps a link announcement — so the rule
    // writes only what that materialiser wrote.
    return systemLinkStatements(change, ctx);
  }

  const statements: SqlStatement[] = [
    ensureEntity(ctx.streamId, id, record.room),
  ];

  if (record.forwardOf !== undefined) {
    // A forward reference carries no content and no author edge: it is an
    // entity in the destination room with a forward edge to each original,
    // which the read path follows.
    for (const target of record.forwardOf) {
      statements.push(sql`
        insert or ignore into edges (head, tail, label)
        select
          ${id},
          ${target},
          'forward'
        where exists (select 1 from entities where id = ${target})
      `);
    }
    statements.push(orderingKey(change));
    return statements;
  }

  statements.push(
    sql`
      insert or replace into comp_content (entity, mime_type, data, last_edit, timestamp)
      values (
        ${id},
        ${record.content.mimeType},
        ${record.content.data},
        ${id},
        ${canonicalSendTime(id, record)}
      )`,
    // The author is the record's own: a bridged message is attributed to the
    // author the bridge overrode, which is the DID the record carries.
    ensureEntity(ctx.streamId, record.author),
    sql`
      insert or replace into edges (head, tail, label)
      select
        ${id},
        ${record.author},
        'author'
    `,
    ...attachmentStatements(ctx.streamId, id, attachmentsOf(record.extensions)),
    orderingKey(change),
  );
  return statements;
}

/**
 * A link announcement: an entity in the linking room, an author edge pointing
 * at the space, and the markdown the event path renders from the linked room's
 * current name. `last_edit` is the message's own id, as the event materialiser
 * writes it, and no `timestamp` is set.
 */
function systemLinkStatements(
  change: Extract<MessageChange, { op: "create" }>,
  ctx: MessageRuleContext,
): SqlStatement[] {
  const record = change.record;
  if (record.system === undefined) return [];
  const link = record.system;
  const id = change.rkey;
  const actor = record.actor;
  if (actor === undefined) {
    throw new Error("message rule: a system message names its actor");
  }
  return [
    sql`
      insert into entities (id, stream_id, room)
      values (${id}, ${ctx.streamId}, ${record.room})
      on conflict do nothing
    `,
    sql`
      insert or ignore into edges (head, tail, label)
      select ${id}, ${ctx.streamId}, 'author'
    `,
    sql`
      insert or replace into comp_content (entity, mime_type, data, last_edit)
      values (
        ${id},
        'text/markdown',
        cast((
          '[@' || ${actor} || '](/user/' || ${actor} || ') '
          || ${link.isCreationLink ? "created [" : "linked to ["}
          || coalesce((select name from comp_info where entity = ${link.linkToRoom}), 'this room')
          || '](' || ${link.linkToRoom} || '?parent=' || ${record.room} || ').'
        ) as blob),
        ${id}
      )
    `,
  ];
}

/** An update is a content replacement (edit) or a room rewrite (move). */
function updateStatements(
  change: Extract<MessageChange, { op: "update" }>,
  ctx: MessageRuleContext,
): SqlStatement[] {
  const id = change.rkey;
  const patch = change.record;

  if (patch.room !== undefined) {
    // A move rewrites the room and re-keys the message at the move's ordering
    // instant, so it lands at the top of the destination timeline rather than
    // at its original send time. The key write is unconditional, unlike a
    // create's: the entity already has one and the move must replace it.
    return [
      sql`update entities set room = ${patch.room} where id = ${id}`,
      sql`update entities set sort_idx = ${change.orderStamp} where id = ${id} and room = ${patch.room}`,
    ];
  }

  const statements: SqlStatement[] = [];
  if (patch.content !== undefined) {
    // The record body is the message's new content. `last_edit` records the
    // write that set it — a record change's identity is its ordering stamp,
    // since the adapter carries no edit event id — and has only to differ from
    // the message id for the read path to report the message as edited.
    statements.push(sql`
      update comp_content
      set
        mime_type = ${patch.content.mimeType},
        data = ${patch.content.data},
        last_edit = ${change.orderStamp}
      where
        entity = ${id}
    `);
  }

  statements.push(...attachmentUpdateStatements(ctx.streamId, id, patch.extensions));
  return statements;
}

/**
 * The attachment half of an edit: an edit that did not mention the attachments
 * leaves them alone, a link-only list flips `show_preview` in place, and
 * anything else replaces the set wholesale.
 */
function attachmentUpdateStatements(
  streamId: StreamDid,
  messageId: Rkey,
  extensions: Readonly<Record<string, unknown>> | null | undefined,
): SqlStatement[] {
  if (extensions === undefined) return [];
  // `null` is "remove every attachment"; a map without the key means the edit
  // did not touch them.
  const carried =
    extensions === null
      ? null
      : ATTACHMENTS in extensions
        ? extensions[ATTACHMENTS]
        : undefined;
  if (carried === undefined) return [];

  const attachments = attachmentsOf(
    carried === null ? undefined : { [ATTACHMENTS]: carried },
  );
  const linkAttachments = attachments.filter(
    (a) => a.$type === "space.roomy.attachment.link.v0",
  );

  if (
    carried !== null &&
    linkAttachments.length === attachments.length &&
    attachments.length > 0
  ) {
    // A link-only edit toggles an embed preview and is non-destructive: it
    // must not wipe the images, videos, comments or replies on the message.
    const statements: SqlStatement[] = [];
    for (const att of linkAttachments) {
      const scoped = att.uri + "?message=" + messageId;
      statements.push(
        ensureEntity(streamId, scoped, messageId),
        sql`
          update comp_embed_link set show_preview = ${att.showPreview ? 1 : 0}
          where entity in (
            select e.id from entities e
            where e.room = ${messageId}
              and (e.id = ${att.uri} or e.id = ${scoped})
          )
        `,
        sql`
          insert into comp_embed_link (entity, show_preview)
          select ${scoped}, ${att.showPreview ? 1 : 0}
          where not exists (
            select 1 from entities e
            join comp_embed_link el on el.entity = e.id
            where e.room = ${messageId}
              and (e.id = ${att.uri} or e.id = ${scoped})
          )
        `,
      );
    }
    return statements;
  }

  const suffix = `%?message=${messageId}`;
  const statements: SqlStatement[] = [
    sql`delete from comp_embed_image where entity like ${suffix}`,
    sql`delete from comp_embed_video where entity like ${suffix}`,
    sql`delete from comp_embed_file where entity like ${suffix}`,
    sql`delete from comp_embed_link where entity like ${suffix}`,
    sql`delete from comp_comment where entity = ${messageId}`,
    sql`delete from edges where head = ${messageId} and label = 'reply'`,
    // Media entities carry the message as their room.
    sql`delete from entities where room = ${messageId} and id != ${messageId}`,
  ];

  // A forward edge belongs to the message's original send and the cleanup
  // above leaves it, so an edit never writes one: the replacement set adds the
  // rows for every other attachment type.
  if (carried !== null) {
    statements.push(
      ...attachmentStatements(
        streamId,
        messageId,
        attachments.filter(
          (a) => a.$type !== "space.roomy.attachment.forward.v0",
        ),
      ),
    );
  }
  return statements;
}

/**
 * A delete removes the message, after the forward references that point at it
 * — while their edges still exist — so no orphan entity is left behind with
 * nothing to reach it.
 */
function deleteStatements(
  change: Extract<MessageChange, { op: "delete" }>,
): SqlStatement[] {
  const id = change.rkey;
  return [
    sql`
      delete from entities where id in (
        select head from edges
        where tail = ${id} and label = 'forward'
      )
    `,
    sql`delete from entities where id = ${id}`,
  ];
}

/**
 * The message's ordering key: its ordering instant and the log position the
 * change was stamped with. Guarded on `sort_idx is null`, so a replayed create
 * cannot re-key a message an earlier derivation already keyed.
 */
function orderingKey(
  change: Extract<MessageChange, { op: "create" }>,
): SqlStatement {
  return sql`update entities set sort_idx = ${change.orderStamp} where id = ${change.rkey} and sort_idx is null`;
}

/**
 * A message's canonical send time: the bridged override when there is one,
 * else the message id's own time. It is not the sort key — that is the stamp —
 * and it is what the timeline renders and the feed orders its window by.
 */
export function canonicalSendTime(id: string, record: MessageRecord): number {
  const override = record.extensions?.[TIMESTAMP_OVERRIDE];
  if (
    override !== null &&
    typeof override === "object" &&
    "timestamp" in override
  ) {
    return Number(override.timestamp);
  }
  return decodeTime(id as Ulid);
}

/**
 * The attachment list a record's extensions carry.
 *
 * The adapter passes the event's extension map through unopened, which is the
 * same trust the event materialiser places in it: a value that is not shaped
 * like an attachment list writes no rows.
 */
function attachmentsOf(
  extensions: Readonly<Record<string, unknown>> | undefined,
): AttachmentInput[] {
  const carried = extensions?.[ATTACHMENTS];
  if (carried === null || typeof carried !== "object") return [];
  if (!("attachments" in carried)) return [];
  const list = carried.attachments;
  return Array.isArray(list) ? (list as AttachmentInput[]) : [];
}
