/**
 * The record path: routing a batch's entries to the message projection rules,
 * and the derived state those rules do not write themselves.
 *
 * A routed entry's statements come from {@link messageStatements}. What stays
 * here is the state that depends on the room's current contents rather than on
 * one message — the `activity_item` window and `room_activity` summary a create
 * extends and a delete or move recomputes — plus the read-state and search work
 * the event path also does after the event's own SQL.
 *
 * The room a message left is not on the record: a move names only its
 * destination and a delete names no room at all. {@link planMessageBatch} reads
 * it from the rows before the chunk's statements run, replaying the chunk's own
 * creates and moves in order so an entry that both creates and moves a message
 * inside one chunk sees the room that was true when its change applied.
 */

import {
  type SqlStatement,
  type StreamDid,
  type Ulid,
  RICHTEXT_MIME,
  extractFacetUrls,
} from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

import type { DbLike } from "../../db/types.ts";
import { decodeContent, decodeRichTextBody } from "../../db/content.ts";
import {
  detectAndStoreLinks,
  detectAndStoreLinksFromUrls,
} from "../../embed/enricher.ts";
import { isThread, refreshThreadActivityOnMessage } from "../../queries/userActiveThreads.ts";
import { upsertUserRoomParticipation } from "../../queries/userRoomParticipation.ts";
import {
  maintainRoomActivityForMessage,
  type MessageActivityTarget,
} from "../../queries/roomActivityProjection.ts";
import { enqueueDeleteMessage, enqueueIndexMessage } from "../../search/indexer.ts";
import type { LoggedEvent } from "../types.ts";
import { upsertActivityItem } from "../activityItem.ts";
import { applyMoveSideEffectsFor } from "../moveMessages.ts";
import { canonicalSendTime, messageStatements, type MessageChange } from "./messageRules.ts";
import { convertedChanges } from "./toRecordChanges.ts";

/** One change the record path applies, with the state its rule reads. */
export interface AppliedMessageChange {
  readonly change: MessageChange;
  /** The room the message was in before this change. */
  readonly priorRoom?: string;
}

/** One log entry applied through the record path. */
export interface RoutedEvent {
  readonly entry: LoggedEvent;
  readonly changes: readonly AppliedMessageChange[];
}

/**
 * Route a chunk: one plan per entry, `null` where the entry stays on the event
 * path. Routing is decided per entry by the adapter's emitted kinds
 * (`convertedChanges`), never by the event type.
 */
export async function planMessageBatch(
  db: DbLike,
  chunk: readonly LoggedEvent[],
  streamId: StreamDid,
): Promise<Array<RoutedEvent | null>> {
  const routed = chunk.map((entry) => convertedChanges(entry, streamId));

  // The rooms the rules cannot read off the change: the source of a move, and
  // the room a delete empties. One read for the chunk, taken before its
  // statements run.
  const needed = new Set<string>();
  for (const changes of routed) {
    for (const change of changes ?? []) {
      if (change.kind !== "message") continue;
      if (change.op === "delete") needed.add(String(change.rkey));
      else if (change.op === "update" && change.record.room !== undefined) {
        needed.add(String(change.rkey));
      }
    }
  }
  const rooms = await readRooms(db, [...needed]);

  return routed.map((changes, i) => {
    if (!changes) return null;
    const applied: AppliedMessageChange[] = [];
    for (const change of changes) {
      if (change.kind !== "message") continue;
      const id = String(change.rkey);
      if (change.op === "create") {
        rooms.set(id, change.record.room);
        applied.push({ change });
      } else if (change.op === "update" && change.record.room !== undefined) {
        applied.push({ change, priorRoom: rooms.get(id) });
        rooms.set(id, change.record.room);
      } else if (change.op === "delete") {
        applied.push({ change, priorRoom: rooms.get(id) });
        rooms.delete(id);
      } else {
        applied.push({ change });
      }
    }
    return { entry: chunk[i]!, changes: applied };
  });
}

/** The room each of `ids` is currently in, skipping rows that are not there. */
async function readRooms(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rooms = new Map<string, string>();
  if (ids.length === 0) return rooms;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db
    .query(`select id, room from entities where id in (${placeholders})`)
    .all<{ id: string; room: string | null }>([...ids]);
  for (const row of rows) if (row.room !== null) rooms.set(row.id, row.room);
  return rooms;
}

/** The statements one routed entry applies, split by when they run. */
export interface MessageEventSteps {
  /** Applied in the entry's own transaction. */
  readonly statements: SqlStatement[];
  /** `room_activity` maintenance, appended after the statements. */
  readonly activity: Array<{ sql: string; params: unknown[] }>;
}

/** The SQL one routed entry applies, in order. */
export function messageEventSteps(
  routed: RoutedEvent,
  opts: { streamId: StreamDid; isBackfill: boolean },
): MessageEventSteps {
  const statements: SqlStatement[] = [];
  const activity: Array<{ sql: string; params: unknown[] }> = [];

  for (const { change, priorRoom } of routed.changes) {
    statements.push(
      ...messageStatements(change, { streamId: opts.streamId, priorRoom }),
    );
    const target = activityTarget(change, priorRoom);
    if (!target) continue;
    const step = maintainRoomActivityForMessage(target, opts.isBackfill);
    if (step) activity.push(step);
  }

  return { statements, activity };
}

/** Which room a change moves the board projection out of, and into. */
function activityTarget(
  change: MessageChange,
  priorRoom: string | undefined,
): MessageActivityTarget | null {
  switch (change.op) {
    case "create":
      // A forward reference is not the room's latest message: it carries no
      // content, so the feed window and the board summary never include it.
      return change.record.forwardOf === undefined
        ? { op: "create", messageId: change.rkey }
        : null;
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

/** The rooms a routed entry's deletes empty, for the window rebuild. */
export function messageDeleteRooms(routed: RoutedEvent): string[] {
  const rooms: string[] = [];
  for (const { change, priorRoom } of routed.changes) {
    if (change.op === "delete" && priorRoom !== undefined) rooms.push(priorRoom);
  }
  return rooms;
}

/** What the record path's side effects read from the batch. */
export interface MessageSideEffectContext {
  readonly streamId: StreamDid;
  /** True for a replay — skips the read-state writes, as the event path does. */
  readonly isBackfill: boolean;
  /** Collects the URLs whose link cards the chunk found. */
  readonly detectedLinks: string[];
  readonly globalDb?: DbLike;
  readonly readStateDb?: DbLike;
}

/**
 * The side effects one routed entry owes after its SQL: activity feed, search,
 * link cards, and the read-state the log cannot supply.
 *
 * Runs per entry, in log order, so the read-state writes interleave with the
 * unconverted entries' exactly as they did when every entry took the event
 * path.
 */
export async function applyMessageSideEffects(
  db: DbLike,
  routed: RoutedEvent,
  ctx: MessageSideEffectContext,
): Promise<void> {
  for (const { change, priorRoom } of routed.changes) {
    if (change.op === "delete") {
      enqueueDeleteMessage(change.rkey);
      continue;
    }

    if (change.op === "update") {
      if (change.record.room === undefined) {
        // An edit: the chunk's statements replaced `comp_content`, and the
        // search worker re-reads the updated plaintext.
        enqueueIndexMessage(ctx.streamId, change.rkey);
        continue;
      }
      await applyMove(db, change, priorRoom, ctx);
      continue;
    }

    await applyCreate(db, change, ctx);
  }
}

/** A create extends the feed and the read state, and may carry link cards. */
async function applyCreate(
  db: DbLike,
  change: Extract<MessageChange, { op: "create" }>,
  ctx: MessageSideEffectContext,
): Promise<void> {
  const record = change.record;
  // A forward reference has no content of its own, so it is not a feed entry.
  if (record.forwardOf !== undefined) return;

  const id = change.rkey;
  const timestamp = canonicalSendTime(id, record);

  await upsertActivityItem(db, {
    roomId: record.room,
    spaceId: ctx.streamId,
    messageId: id as unknown as Ulid,
    timestamp,
  });

  if (!ctx.isBackfill && ctx.readStateDb) {
    // The record's author is the DID its content is attributed to, which is the
    // overridden author for a bridged message — the same DID the participation
    // write below uses.
    if (await isThread(db, record.room)) {
      await refreshThreadActivityOnMessage(
        ctx.readStateDb,
        record.room,
        record.author,
        ctx.streamId,
        timestamp,
      );
    }
    await upsertUserRoomParticipation(
      ctx.readStateDb,
      record.author,
      record.room,
      timestamp,
    );
  }

  // Search indexing: enqueue the message for the out-of-band indexer, which
  // re-reads the materialised rows.
  enqueueIndexMessage(ctx.streamId, id);

  const content = record.content;
  if (!content) return;
  const buffer = Buffer.from(content.data);
  let detected: string[];
  if (content.mimeType === RICHTEXT_MIME) {
    // URLs come from `#link` facet URIs, not regex scanning.
    const blocks = decodeRichTextBody(content.mimeType, buffer);
    detected = await detectAndStoreLinksFromUrls(
      db,
      id,
      blocks ? extractFacetUrls(blocks) : [],
    );
  } else {
    detected = await detectAndStoreLinks(
      db,
      id,
      decodeContent(content.mimeType, buffer),
    );
  }

  if (detected.length === 0) return;
  ctx.detectedLinks.push(...detected);
  if (!ctx.globalDb) return;
  // Link entities carry an empty stream_id in the per-space DB, so the global
  // index is what resolves them to this space; the pending-links index is what
  // the embed sweeper walks without opening every per-space DB.
  for (const url of detected) {
    await ctx.globalDb.run(
      `insert or ignore into entity_space (entity_id, space_did) values (?, ?)`,
      [url, ctx.streamId],
    );
    await ctx.globalDb.run(
      `insert or ignore into pending_links (space_did, message_id, url, created_at)
       values (?, ?, ?, ?)`,
      [ctx.streamId, id, url, Date.now()],
    );
  }
}

/**
 * A move re-applies the message in its destination and unwinds it from the
 * source: both rooms' feed windows and board summaries, then the read state.
 *
 * The feed stamps the moved message at the move's ordering instant, so the
 * window reads by the same instant the timeline does. That instant is the
 * stamp's time half — the value `rebuildActivityWindow` decodes from `sort_idx`.
 */
async function applyMove(
  db: DbLike,
  change: Extract<MessageChange, { op: "update" }>,
  priorRoom: string | undefined,
  ctx: MessageSideEffectContext,
): Promise<void> {
  const toRoom = change.record.room;
  if (toRoom === undefined || priorRoom === undefined) return;

  await applyMoveSideEffectsFor(db, {
    streamId: ctx.streamId,
    fromRoom: priorRoom,
    toRoom,
    messageIds: [change.rkey as unknown as Ulid],
    movedAt: decodeTime(change.orderStamp as unknown as Ulid),
    readStateDb: ctx.readStateDb,
    isBackfill: ctx.isBackfill,
  });

  // Re-index: the search worker reads the message's `room` from the per-space
  // DB and filters on it, so a moved message must be re-upserted to leave the
  // source room's results.
  enqueueIndexMessage(ctx.streamId, change.rkey);
}
