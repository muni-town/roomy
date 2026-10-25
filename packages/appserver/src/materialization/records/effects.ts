/**
 * The effect layer: one record change's complete effect list, in application
 * order.
 *
 * `changeStatements` answers what a change writes; a change's *effects* also
 * include the projection maintenance its own entry appends and the derived
 * state that has to read rows before it can write them. A worker that applies
 * only the rule statements would miss those, so they live here rather than in
 * the batch loop: one change, one ordered list, no step reachable from a second
 * call site.
 *
 * Two shapes, because two things happen:
 *
 *  - {@link SqlEffect} — a fixed statement against the space's DB or the global
 *    DB. `sql` is the rule's own text, `params` its bindings.
 *  - {@link DerivedStep} — an effect that must read rows and compute before it
 *    writes (the activity window decodes the ordering time out of `sort_idx`
 *    and JSON-encodes the window; a reorder key is computed between
 *    neighbours). One enum variant per step, never a closure — the same list is
 *    what a non-JavaScript implementation applies.
 *
 * Applying is `derivedSteps.ts`'s job for the steps and the caller's for the
 * statements; the target on each effect says which DB receives it.
 */

import { RICHTEXT_MIME, extractFacetUrls, type StreamDid } from "@roomy-space/sdk";

import { decodeTime } from "ulidx";

import { decodeContent, decodeRichTextBody } from "../../db/content.ts";
import { extractUrls } from "../../embed/enricher.ts";
import { linkAttachmentUrls } from "../../queries/links.ts";
import { maintainRoomActivityForMessage } from "../../queries/roomActivityProjection.ts";
import { roomAccessStepForRoom } from "../../queries/roomAccessProjection.ts";
import { canonicalSendTime, type MessageChange } from "./messageRules.ts";
import type { MessageContent } from "./recordKinds.ts";
import type { RecordChange } from "./recordChange.ts";
import { changeStatements, type RuleContext } from "./recordRules.ts";

/** Which database a rule statement targets. */
export type EffectTarget = "space" | "global";

/** A fixed statement, applied as it stands. */
export interface SqlEffect {
  readonly effect: "sql";
  readonly target: EffectTarget;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * An effect that reads the rows first.
 *
 * `rebuildActivityWindow` recomputes a room's `activity_item` window and its
 * `room_activity` summary from the messages that remain — the step a delete or
 * a move invalidates. `setMessageSortIdxByReorder` keys a message between its
 * neighbours (the one effect whose value depends on rows written around it).
 */
export type DerivedStep =
  | {
      readonly effect: "rebuildActivityWindow";
      readonly roomId: string;
    }
  | {
      /** Fold one message into its room's feed window and board summary. */
      readonly effect: "upsertActivityItem";
      readonly spaceId: StreamDid;
      readonly roomId: string;
      readonly messageId: string;
      /** The message's canonical send time — not its ordering key. */
      readonly timestamp: number;
    }
  | {
      /** The link entities and `comp_embed_link` rows a message's content names. */
      readonly effect: "storeLinks";
      readonly spaceId: StreamDid;
      readonly messageId: string;
      readonly urls: readonly string[];
      /** The instant the log assigns the change: the rows' clock stamp. */
      readonly at: number;
    }
  | {
      /**
       * A message's link attachments, queued for the embed sweeper under their
       * canonical URLs. The materialiser already wrote their per-message
       * entities (`uri?message=<id>`) and `comp_embed_link` rows, so this step
       * queues only — writing a bare-URL entity here would list the same
       * attachment twice.
       */
      readonly effect: "queueLinkAttachments";
      readonly spaceId: StreamDid;
      readonly messageId: string;
      readonly urls: readonly string[];
    }
  | {
      readonly effect: "setMessageSortIdxByReorder";
      readonly streamId: StreamDid;
      readonly messageId: string;
      readonly after: string;
    };

/** One change's effects, in the order the event path applied them. */
export type Effect = SqlEffect | DerivedStep;

/**
 * The effects that apply one change.
 *
 * Ordered: the kind's own statements, then the projection its entry maintains
 * (`room_activity` for a message, `room_access` for a room), then the derived
 * steps the change invalidates. That is the order the event path wrote them in,
 * so a rule and a materialiser produce the same projection.
 */
export function changeEffects(
  change: RecordChange,
  ctx: RuleContext,
): Effect[] {
  const effects: Effect[] = [];
  for (const statement of changeStatements(change, ctx)) {
    const params =
      statement.params === undefined
        ? []
        : Array.isArray(statement.params)
          ? (statement.params as readonly unknown[])
          : [statement.params];
    effects.push({
      effect: "sql",
      target: statement.derived,
      sql: statement.sql,
      params,
    });

    // Every entity a rule creates is also indexed by the space that owns it,
    // in the global DB. The write path derives that from the statement's text;
    // naming it here keeps the global half of the change in the same list as
    // the space half. A link entity carries an empty stream id and is indexed
    // by its message instead, so it is skipped.
    if (
      statement.sql.trimStart().startsWith("insert into entities") &&
      typeof params[0] === "string" &&
      typeof params[1] === "string" &&
      params[1] !== ""
    ) {
      effects.push({
        effect: "sql",
        target: "global",
        sql: "insert or ignore into entity_space (entity_id, space_did) values (?, ?)",
        params: [params[0], params[1]],
      });
    }
  }

  if (change.kind === "message") {
    const target = activityTarget(change, ctx.priorRoom);
    const step = target && maintainRoomActivityForMessage(target, ctx.isBackfill);
    if (step) {
      effects.push({
        effect: "sql",
        target: "space",
        sql: step.sql,
        params: step.params,
      });
    }
    effects.push(...derivedStepsFor(change, ctx));
  } else if (change.kind === "room") {
    const step = roomAccessStepForRoom(ctx.streamId, ctx.isBackfill);
    effects.push({
      effect: "sql",
      target: "space",
      sql: step.sql,
      params: step.params,
    });
  }

  return effects;
}

/**
 * The derived steps a change invalidates.
 *
 * A `deleteMessage` names no room and a `moveMessages` names only its
 * destination, so the rooms come from the context the planner read. Both are
 * recomputations from the rows that remain, never a record of the removal.
 *
 * A create adds the message to its room's feed window and stores the links its
 * content names; the system message and the forward reference do neither,
 * because the event path never folded either into a room's feed and neither
 * carries text of its own.
 */
function derivedStepsFor(
  change: MessageChange,
  ctx: RuleContext,
): DerivedStep[] {
  const steps: DerivedStep[] = [];

  switch (change.op) {
    case "create": {
      const record = change.record;
      if (record.system !== undefined || record.forwardOf !== undefined) break;
      const id = change.rkey;
      steps.push({
        effect: "upsertActivityItem",
        spaceId: ctx.streamId,
        roomId: record.room,
        messageId: id,
        timestamp: canonicalSendTime(id, record),
      });
      const urls = linksIn(record.content);
      if (urls.length > 0) {
        steps.push({
          effect: "storeLinks",
          spaceId: ctx.streamId,
          messageId: id,
          urls,
          at: ctx.decidedAt,
        });
      }
      // A link attachment materialises as its own entity (`uri?message=<id>`)
      // with its own `comp_embed_link` row, so `linksIn` never sees it: a
      // message whose entire payload is a link — a bridged embed, say — has no
      // other source of enrichment. Queue its canonical URL beside the body
      // URLs; the sweeper fetches the URL the reads resolve the embed under.
      const attachmentUrls = linkAttachmentUrls(record.extensions);
      if (attachmentUrls.length > 0) {
        steps.push({
          effect: "queueLinkAttachments",
          spaceId: ctx.streamId,
          messageId: id,
          urls: attachmentUrls,
        });
      }
      break;
    }
    case "update": {
      const toRoom = change.record.room;
      if (toRoom === undefined) break;
      // A move lands at the top of the destination's feed window, stamped with
      // the move's own ordering instant — the stamp's time half.
      steps.push({
        effect: "upsertActivityItem",
        spaceId: ctx.streamId,
        roomId: toRoom,
        messageId: change.rkey,
        timestamp: decodeTime(change.orderStamp),
      });
      for (const roomId of [ctx.priorRoom, toRoom]) {
        if (roomId === undefined) continue;
        if (steps.some((step) => step.effect === "rebuildActivityWindow" && step.roomId === roomId)) {
          continue;
        }
        steps.push({ effect: "rebuildActivityWindow", roomId });
      }
      break;
    }
    case "delete":
      if (ctx.priorRoom !== undefined) {
        steps.push({ effect: "rebuildActivityWindow", roomId: ctx.priorRoom });
      }
      break;
  }

  return steps;
}

/**
 * The URLs a message's content names — a rich-text body's `#link` facets, or
 * the URLs its plain text carries. The same rule the read path applies, so a
 * link is stored exactly where it would be discovered by scanning.
 */
function linksIn(content: MessageContent): string[] {
  const buffer = Buffer.from(content.data);
  if (content.mimeType === RICHTEXT_MIME) {
    const blocks = decodeRichTextBody(content.mimeType, buffer);
    return blocks ? extractFacetUrls(blocks) : [];
  }
  return extractUrls(decodeContent(content.mimeType, buffer));
}

/** Which room a message change moves the board projection out of, and into. */
function activityTarget(
  change: MessageChange,
  priorRoom: string | undefined,
): Parameters<typeof maintainRoomActivityForMessage>[0] | null {
  switch (change.op) {
    case "create":
      // A system message arrives only from a link, which the event path never
      // folded into the room's feed; a forward reference carries no content, so
      // the feed window and the board summary never include either.
      return change.record.content === undefined
        ? null
        : { op: "create", messageId: change.rkey };
    case "update":
      return change.record.room === undefined
        ? null
        : {
            op: "move",
            messageId: change.rkey,
            fromRoom: priorRoom,
            toRoom: change.record.room,
          };
    case "delete":
      return priorRoom === undefined
        ? null
        : { op: "delete", messageId: change.rkey, fromRoom: priorRoom };
  }
}
