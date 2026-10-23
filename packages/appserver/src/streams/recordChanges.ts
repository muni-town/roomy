/**
 * The interim change feed: the adapter's output, persisted per log entry.
 *
 * `docs/plans/replicable-space-workers.md` §5 WS3 makes `RecordChange` the
 * materialiser's input type while `stream_events` stays the source of truth.
 * A worker that is not this process cannot read the event log and re-run the
 * adapter, because the event→record adapter must exist once. So the adapter's
 * output is written to the event-log DB at ingest, next to the log entry it
 * descends from, and the worker reads rows rather than events.
 *
 * Three properties the feed keeps:
 *
 *  - **One entry, several rows.** `createRoomLink` emits a `room` update and a
 *    `message` create; `federation.remove` deletes two kinds. `ord` is the
 *    emission order within the entry, so `(idx, ord)` is a total order over
 *    changes that agrees with the log.
 *  - **Same key, same order.** `order_stamp` is the log's ordering key, so a
 *    worker sorting by it produces the projection the materialiser produces
 *    without reading the log again.
 *  - **The entry's own facts travel too.** `actor` and `event_id` are on the
 *    row because two rules key rows by them: membership's announcement message
 *    is keyed by the join event's id, `comp_invite.event_ulid` by the invite
 *    event's, and a call fact's `joined_at` decodes the event id. They are
 *    properties of the entry, not of the record, so they are columns rather
 *    than fields of the body.
 *
 * The rows are written for the kinds the projection rules apply. An event type
 * that emits no record — `setHandleProvider`, `editPage`, `reorderMessage` —
 * writes nothing, which is the feed saying what the record model says.
 */

import { decodeTime } from "ulidx";

import type { StreamDid } from "@roomy-space/sdk";

import type { DbLike } from "../db/types.ts";
import { log } from "../log.ts";
import type {
  OrderStamp,
  RecordChange,
  Rkey,
} from "../materialization/records/recordChange.ts";
import {
  RECORD_KINDS,
  type Nsid,
  type RecordKind,
} from "../materialization/records/recordKinds.ts";
import {
  CONVERTED_KINDS,
  RECORD_KINDS_FOR_EVENT,
  toRecordChanges,
} from "../materialization/records/toRecordChanges.ts";
import type { LoggedEvent } from "../materialization/types.ts";

/** One row of `record_changes`, as the worker reads it. */
export interface RecordChangeRow {
  readonly streamId: string;
  readonly idx: number;
  /** Emission order within the entry. */
  readonly ord: number;
  readonly kind: string;
  readonly repo: string;
  readonly collection: string;
  readonly rkey: string;
  readonly op: "create" | "update" | "delete";
  readonly orderStamp: string;
  readonly actor: string;
  readonly eventId: string;
  /** The encoded record or patch; `null` for a delete. */
  readonly body: string | null;
}

/**
 * The changes one log entry contributes to the feed.
 *
 * An event whose kinds are all converted carries its changes; an event that
 * emits no record, or that the adapter cannot describe, contributes nothing.
 * A malformed row is skipped rather than thrown: the feed is written on the
 * write path, and one unreadable entry must not fail the append that produced
 * it — the backfill script reports the same entry when it is re-run.
 */
export function feedChanges(
  entry: LoggedEvent,
  streamId: StreamDid,
): RecordChange[] {
  const declared = RECORD_KINDS_FOR_EVENT[entry.event.$type];
  if (declared === undefined || declared.length === 0) return [];
  if (!declared.every((kind) => CONVERTED_KINDS.has(kind))) return [];

  let changes: RecordChange[];
  try {
    changes = toRecordChanges(entry, streamId);
  } catch (err) {
    log.warn(
      `[record-changes] no change for event ${entry.event.id} (${entry.event.$type}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  return changes.every((change) => CONVERTED_KINDS.has(change.kind))
    ? changes
    : [];
}

/**
 * The rows one entry contributes. The body is the change's record as JSON, with
 * bytes carried as `{"$bytes": "<base64>"}` so a body that holds a message's
 * raw content or an attachment survives the trip to another implementation.
 */
export function feedRows(
  entry: LoggedEvent,
  streamId: StreamDid,
): RecordChangeRow[] {
  return feedChanges(entry, streamId).map((change, ord) => ({
    streamId,
    idx: entry.idx,
    ord,
    kind: change.kind,
    repo: change.repo,
    collection: change.collection,
    rkey: change.rkey,
    op: change.op,
    orderStamp: change.orderStamp,
    actor: entry.user,
    eventId: entry.event.id,
    body:
      change.op === "delete"
        ? null
        : JSON.stringify(encodeBytes(change.record)),
  }));
}

/** Replace every `Uint8Array` in a JSON-shaped value with a base64 marker. */
export function encodeBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encodeBytes);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = encodeBytes(inner);
    }
    return out;
  }
  return value;
}

/**
 * The inverse of {@link encodeBytes}: a body read back into the shapes the
 * rules expect. A marker is a three-key object whose only member is `$bytes`
 * and whose value is a valid base64 string, which no record field can collide
 * with.
 */
export function decodeBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "$bytes") {
      const data = record.$bytes;
      if (typeof data !== "string") {
        throw new Error("record change body: $bytes is not a string");
      }
      return new Uint8Array(Buffer.from(data, "base64"));
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) {
      out[key] = decodeBytes(inner);
    }
    return out;
  }
  return value;
}

/**
 * Write one log batch's changes, in the batch's own order.
 *
 * `replace` makes the write idempotent, which is what lets the backfill script
 * re-run over a stream and overwrite what the live path already wrote.
 */
export async function writeRecordChanges(
  db: DbLike,
  streamId: StreamDid,
  entries: readonly LoggedEvent[],
): Promise<void> {
  const rows = entries.flatMap((entry) => feedRows(entry, streamId));
  if (rows.length === 0) return;

  await db.transaction(
    rows.map((row) => ({
      type: "run" as const,
      sql: `insert or replace into record_changes (
             stream_id, idx, ord, kind, repo, collection, rkey, op,
             order_stamp, actor, event_id, body
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        row.streamId,
        row.idx,
        row.ord,
        row.kind,
        row.repo,
        row.collection,
        row.rkey,
        row.op,
        row.orderStamp,
        row.actor,
        row.eventId,
        row.body,
      ],
    })),
  );
}

/**
 * Read a stream's changes from `cursor` onwards, in `(idx, ord)` order — the
 * order the worker applies them in. `limit` bounds one batch; the cursor the
 * caller advances is the last row it read.
 */
export async function readRecordChanges(
  db: DbLike,
  streamId: string,
  cursor: number,
  limit: number,
): Promise<RecordChangeRow[]> {
  const rows = await db
    .query(
      `select stream_id, idx, ord, kind, repo, collection, rkey, op,
              order_stamp, actor, event_id, body
         from record_changes
        where stream_id = ? and idx >= ?
        order by idx, ord
        limit ?`,
    )
    .all<{
      stream_id: string;
      idx: number;
      ord: number;
      kind: string;
      repo: string;
      collection: string;
      rkey: string;
      op: "create" | "update" | "delete";
      order_stamp: string;
      actor: string;
      event_id: string;
      body: string | null;
    }>([streamId, cursor, limit]);

  return rows.map((row) => ({
    streamId: row.stream_id,
    idx: row.idx,
    ord: row.ord,
    kind: row.kind,
    repo: row.repo,
    collection: row.collection,
    rkey: row.rkey,
    op: row.op,
    orderStamp: row.order_stamp,
    actor: row.actor,
    eventId: row.event_id,
    body: row.body,
  }));
}

/**
 * A row read back as the change it was written from.
 *
 * Decoding validates that the row's `collection` is its kind's — the property
 * the TypeScript type enforces at construction — so a feed row whose two
 * disagree is an error here rather than a rule applied to the wrong table.
 */
export function rowToChange(row: RecordChangeRow): RecordChange {
  const kind = row.kind as RecordKind;
  const spec = RECORD_KINDS[kind] as { collection: string } | undefined;
  if (spec === undefined) {
    throw new Error(`record change: unknown kind ${row.kind}`);
  }
  if (spec.collection !== row.collection) {
    throw new Error(
      `record change: kind ${row.kind} has collection ${spec.collection}, the row says ${row.collection}`,
    );
  }

  const base = {
    kind,
    repo: row.repo,
    collection: row.collection as Nsid<RecordKind>,
    rkey: row.rkey as Rkey,
    orderStamp: row.orderStamp as OrderStamp,
  };
  if (row.op === "delete") return { ...base, op: "delete" } as RecordChange;
  if (row.body === null) {
    throw new Error(`record change: ${row.op} row ${row.kind} carries no body`);
  }
  return {
    ...base,
    op: row.op,
    record: decodeBytes(JSON.parse(row.body)),
  } as RecordChange;
}

/**
 * The time half of an ordering stamp, in epoch milliseconds.
 *
 * A stamp is a 26-character log key: ten characters of ordering time followed
 * by sixteen of log position (`materialization/sortIdx.ts`). A consumer that
 * needs the ordering instant — the activity feed stamps a moved message at it —
 * reads it here rather than parsing the stamp in the rule.
 */
export function stampTime(stamp: string): number {
  // The decoder reads a full ULID, so the position half stands in for the
  // random half: only the time it shares is read.
  return decodeTime(stamp);
}
