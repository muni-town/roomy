/**
 * Activity item upsert side-effect for the materialization pipeline.
 *
 * Called from `applyBundle.ts` on every `createMessage.v0` event. Maintains
 * the `activity_item` table — one row per room, with a rolling window of up to
 * 5 recent message ULIDs (newest first). Denormalized space/channel names are
 * fetched on first insert; subsequent updates only touch message IDs and the
 * activity timestamp.
 *
 * During backfill the upsert still runs — events arrive in monotonically
 * increasing `idx` order so each new message is correctly prepended.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, Ulid } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

export interface ActivityItemUpsertOpts {
  roomId: string;
  spaceId: StreamDid;
  messageId: Ulid;
}

/**
 * Upsert the activity item for a room after a new message lands.
 *
 * Strategy:
 *   1. Check if a row already exists.
 *   2. If yes: read the existing recent_message_ids JSON array, prepend the
 *      new messageId, slice to at most 5, and update last_activity_at.
 *   3. If no: insert with all denormalized metadata fetched in one query.
 */
export async function upsertActivityItem(
  db: DbLike,
  opts: ActivityItemUpsertOpts,
): Promise<void> {
  const existing = await db
    .query(
      `select recent_message_ids from activity_item where room_id = ?`,
    )
    .get<{ recent_message_ids: string }>(opts.roomId);

  if (existing) {
    // Fast path: prepend to the message ID list, cap at 5.
    const ids: string[] = JSON.parse(existing.recent_message_ids);
    // Remove duplicate if somehow present, then prepend.
    const deduped = ids.filter((id) => id !== opts.messageId);
    deduped.unshift(opts.messageId);
    const capped: string[] = deduped.slice(0, 5);

    await (await db.prepare(
      `update activity_item
          set last_activity_at = ?,
              recent_message_ids = ?,
              updated_at = (unixepoch() * 1000)
        where room_id = ?`,
    )).run(
      // Timestamp: decode from the message ULID to match canonical ordering.
      decodeMessageTimestamp(opts.messageId),
      JSON.stringify(capped),
      opts.roomId,
    );
  } else {
    // Slow path: first message in this room — fetch all metadata.
    await insertActivityItem(db, opts);
  }
}

/**
 * First insert for a room: fetch all denormalized metadata in bulk.
 */
async function insertActivityItem(
  db: DbLike,
  opts: ActivityItemUpsertOpts,
): Promise<void> {
  const roomMeta = await db
    .query(
      `select
         cr.label as label,
         ri.name as room_name,
         si.name as space_name,
         si.avatar as space_avatar,
         parent_e.head as parent_id,
         parent_ci.name as parent_name
       from comp_room cr
       left join comp_info ri on ri.entity = cr.entity
       left join comp_info si on si.entity = ?2
       left join edges parent_e
         on parent_e.tail = cr.entity
         and parent_e.label = 'link'
         and coalesce(json_extract(parent_e.payload, '$.canonical_parent'), 0) = 1
       left join comp_info parent_ci on parent_ci.entity = parent_e.head
       where cr.entity = ?1`,
    )
    .get<{
      label: string | null;
      room_name: string | null;
      space_name: string | null;
      space_avatar: string | null;
      parent_id: string | null;
      parent_name: string | null;
    }>(opts.roomId, opts.spaceId);

  const isThread = roomMeta?.label === "space.roomy.thread" ? 1 : 0;
  const timestamp = decodeMessageTimestamp(opts.messageId);

  await (await db.prepare(
    `insert into activity_item (
       room_id, space_id, is_thread, parent_channel_id, parent_channel_name,
       last_activity_at, recent_message_ids,
       room_name, space_name, space_avatar,
       created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (unixepoch() * 1000), (unixepoch() * 1000))`,
  )).run(
    opts.roomId,
    opts.spaceId,
    isThread,
    roomMeta?.parent_id ?? null,
    roomMeta?.parent_name ?? null,
    timestamp,
    JSON.stringify([opts.messageId]),
    roomMeta?.room_name ?? null,
    roomMeta?.space_name ?? null,
    roomMeta?.space_avatar ?? null,
  );
}

/**
 * Decode the canonical timestamp from a message ULID.
 * Matches the materializer's decodeTime(event.id) logic.
 */
export function decodeMessageTimestamp(messageId: string): number {
  return decodeTime(messageId);
}
