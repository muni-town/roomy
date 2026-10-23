/**
 * The record path: routing a batch's entries to the projection rules, and the
 * derived state those rules do not write themselves.
 *
 * A routed entry's effects come from {@link changeEffects} — its statements,
 * the projection it maintains and the derived steps it invalidates, in
 * application order. What stays here is the state that depends on the rows
 * rather than on one record — the room a message was in before a move or a
 * delete, the parent a link clears, the room a voice fact belongs to — plus the
 * read-state and search work the event path also does after the event's own
 * SQL.
 *
 * Those values are not on the record: a move names only its destination, a
 * delete names no room at all, an unlink names only the room it unlinks, and a
 * call fact names only the call. {@link planBatch} reads them before the chunk's
 * statements run, replaying the chunk's own creates, moves and links in order so
 * an entry that both creates and moves a record inside one chunk sees the state
 * the earlier change produced.
 *
 * The room a message left is the one case the effects read directly: a delete
 * carries no room, and a move carries only its destination.
 */

import { type StreamDid, type Ulid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

import type { DbLike } from "../../db/types.ts";
import { isThread, refreshThreadActivityOnMessage } from "../../queries/userActiveThreads.ts";
import { upsertUserRoomParticipation } from "../../queries/userRoomParticipation.ts";
import { enqueueDeleteMessage, enqueueIndexMessage } from "../../search/indexer.ts";
import type { LoggedEvent } from "../types.ts";
import { applyMoveSideEffectsFor } from "../moveMessages.ts";
import type { RecordChange } from "./recordChange.ts";
import { changeEffects, type Effect } from "./effects.ts";
import { canonicalSendTime, type MessageChange } from "./messageRules.ts";
import { entryContext } from "./recordRules.ts";
import { convertedChanges } from "./toRecordChanges.ts";

/** One change the record path applies, with the state its rule reads. */
export interface AppliedChange {
  readonly change: RecordChange;
  /** The room the record was in before this change. */
  readonly priorRoom?: string;
  /** The room a link's `parent` pointed at before this change. */
  readonly priorParent?: string;
}

/** One log entry applied through the record path. */
export interface RoutedEvent {
  readonly entry: LoggedEvent;
  readonly changes: readonly AppliedChange[];
}

/**
 * Route a chunk: one plan per entry, `null` where the entry stays on the event
 * path. Routing is decided per entry by the adapter's emitted kinds
 * (`convertedChanges`), never by the event type.
 */
export async function planBatch(
  db: DbLike,
  chunk: readonly LoggedEvent[],
  streamId: StreamDid,
): Promise<Array<RoutedEvent | null>> {
  return await planChanges(
    db,
    chunk.map((entry) => ({
      entry,
      changes: convertedChanges(entry, streamId),
    })),
  );
}

/** One entry and the changes it applies through the rules. */
export interface ChangeEntry {
  readonly entry: LoggedEvent;
  /** `null` when the entry stays on the event path. */
  readonly changes: readonly RecordChange[] | null;
}

/**
 * Plan a batch whose changes the caller already has.
 *
 * {@link planBatch} derives them from the log entries; a consumer reading a
 * persisted change feed (`streams/recordChanges.ts`) already holds them, and
 * plans from the same code so the state a rule reads is read one way.
 */
export async function planChanges(
  db: DbLike,
  batch: readonly ChangeEntry[],
): Promise<Array<RoutedEvent | null>> {
  const routed = batch.map((item) => item.changes);

  // The state the rules cannot read off the change: the source of a message
  // move and the room a message delete empties, the parent a link clears, and
  // the room a call fact belongs to. One read for the chunk, taken before its
  // statements run.
  const neededRooms = new Set<string>();
  const neededParents = new Set<string>();
  const neededCalls = new Set<string>();
  for (const changes of routed) {
    for (const change of changes ?? []) {
      if (change.kind === "message") {
        if (change.op === "delete") neededRooms.add(String(change.rkey));
        else if (change.op === "update" && change.record.room !== undefined) {
          neededRooms.add(String(change.rkey));
        }
      } else if (
        change.kind === "room" &&
        change.op === "update" &&
        change.record.parent === null
      ) {
        neededParents.add(String(change.rkey));
      } else if (change.kind === "voiceCall" && change.op !== "create") {
        // A call fact names only the call; the room is in the row the start
        // wrote.
        neededCalls.add(String(change.rkey));
      }
    }
  }
  const rooms = await readRooms(db, [...neededRooms]);
  const parents = await readCanonicalParents(db, [...neededParents]);
  const calls = await readCallRooms(db, [...neededCalls]);

  return routed.map((changes, i) => {
    if (!changes) return null;
    const applied: AppliedChange[] = [];
    for (const change of changes) {
      const id = String(change.rkey);
      if (change.kind === "message") {
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
      } else if (
        change.kind === "room" &&
        change.op === "update" &&
        change.record.parent !== undefined
      ) {
        if (change.record.parent === null) {
          applied.push({ change, priorParent: parents.get(id) });
          parents.delete(id);
        } else {
          applied.push({ change });
          parents.set(id, change.record.parent);
        }
      } else if (change.kind === "voiceCall") {
        if (change.op === "create") {
          calls.set(id, change.record.room);
          applied.push({ change });
        } else if (change.op === "delete") {
          applied.push({ change, priorRoom: calls.get(id) });
          calls.delete(id);
        } else {
          applied.push({ change, priorRoom: calls.get(id) });
        }
      } else {
        applied.push({ change });
      }
    }
    return { entry: batch[i]!.entry, changes: applied };
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

/**
 * The canonical parent of each of `ids`: the `link` edge whose payload marks it
 * first-written. A room can be linked from several parents and the record model
 * carries one, so the canonical edge is the one an unlink clears.
 */
async function readCanonicalParents(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const parents = new Map<string, string>();
  if (ids.length === 0) return parents;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db
    .query(
      `select tail, head from edges
        where label = 'link'
          and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
          and tail in (${placeholders})`,
    )
    .all<{ tail: string; head: string }>([...ids]);
  for (const row of rows) parents.set(row.tail, row.head);
  return parents;
}

/**
 * The room each call is in, from `active_calls`: a call fact names only its
 * call, and every participant row and call-end is keyed by the room too.
 */
async function readCallRooms(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rooms = new Map<string, string>();
  if (ids.length === 0) return rooms;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db
    .query(
      `select call_id, room_id from active_calls where call_id in (${placeholders})`,
    )
    .all<{ call_id: string; room_id: string }>([...ids]);
  for (const row of rows) rooms.set(row.call_id, row.room_id);
  return rooms;
}

/**
 * The effects one routed entry applies, in order.
 *
 * The statements carry their own target, so the caller does not route them by
 * matching SQL text; the derived steps are what the caller applies through
 * `derivedSteps.ts` once the entry's SQL has run.
 */
export function recordEntryEffects(
  routed: RoutedEvent,
  opts: { streamId: StreamDid; isBackfill: boolean },
): Effect[] {
  const effects: Effect[] = [];
  for (const { change, priorRoom, priorParent } of routed.changes) {
    effects.push(
      ...changeEffects(
        change,
        entryContext(routed.entry, opts.streamId, {
          priorRoom,
          priorParent,
          isBackfill: opts.isBackfill,
        }),
      ),
    );
  }
  return effects;
}

/** What the record path's side effects read from the batch. */
export interface RecordSideEffectContext {
  readonly streamId: StreamDid;
  /** True for a replay — skips the read-state writes, as the event path does. */
  readonly isBackfill: boolean;
  readonly readStateDb?: DbLike;
}

/**
 * The side effects one routed entry owes after its SQL: search, and the
 * read-state the log cannot supply. The per-space derived state the entry
 * writes — its feed window, its link rows — is in its effect list.
 *
 * Runs per entry, in log order, so the read-state writes interleave with the
 * unconverted entries' exactly as they did when every entry took the event
 * path. Only a `message` change has any: a room, membership or permission
 * change has no out-of-transaction work.
 */
export async function applyRecordSideEffects(
  db: DbLike,
  routed: RoutedEvent,
  ctx: RecordSideEffectContext,
): Promise<void> {
  for (const { change, priorRoom } of routed.changes) {
    if (change.kind !== "message") continue;
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
  ctx: RecordSideEffectContext,
): Promise<void> {
  const record = change.record;
  // A system message is not a feed entry: the event path never folded a link
  // announcement into the room's summary or any user's read state.
  if (record.system !== undefined) return;
  // Neither is a forward reference: it has no content of its own.
  if (record.forwardOf !== undefined) return;

  const id = change.rkey;
  const timestamp = canonicalSendTime(id, record);

  // The room's feed window is folded in by the change's `upsertActivityItem`
  // step, which the batch applies.
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
  ctx: RecordSideEffectContext,
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
    // The change's effect list carries the feed upsert and the room-window
    // steps, so this applies only the read-state half.
    derived: "caller",
  });

  // Re-index: the search worker reads the message's `room` from the per-space
  // DB and filters on it, so a moved message must be re-upserted to leave the
  // source room's results.
  enqueueIndexMessage(ctx.streamId, change.rkey);
}
