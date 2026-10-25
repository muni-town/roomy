/**
 * Application of a {@link DerivedStep} — the effects that read before they
 * write.
 *
 * One implementation per variant, called from both materialisation paths: the
 * record path applies the steps its changes carry, and the event path builds
 * the same step for a `reorderMessage`, whose ordering key depends on its
 * neighbours. A step is never reached from a second call site, so a room's
 * window is rebuilt once and a reorder key is computed once.
 */

import type { Event, StreamDid, Ulid } from "@roomy-space/sdk";

import type { DbLike } from "../db/types.ts";
import { upsertActivityItem } from "./activityItem.ts";
import { rebuildRoomActivity } from "../queries/roomActivityProjection.ts";
import { refreshActivityMeta } from "./activityItem.ts";
import type { DerivedStep } from "./records/effects.ts";
import { rebuildActivityWindow } from "./roomDerivedState.ts";
import { setMessageSortIdxByReorder } from "./sortIdx.ts";

/**
 * Apply one derived step. Returns the URLs the write path offers the embed
 * sweeper: the ones whose `comp_embed_link` row the step newly stored, and —
 * for a link attachment — the ones it queued. Every other step returns nothing.
 */
export async function applyDerivedStep(
  db: DbLike,
  step: DerivedStep,
  globalDb?: DbLike,
): Promise<string[]> {
  switch (step.effect) {
    case "rebuildActivityWindow":
      // The `activity_item` window and the `room_activity` summary both
      // describe the room whose message set just changed, so one step keeps
      // both in step with the rows that remain. The row's names are the current
      // ones — a rename rebuilds the row it renamed rather than leaving the old
      // name in the feed.
      await rebuildActivityWindow(db, step.roomId);
      await refreshActivityMeta(db, step.roomId);
      await rebuildRoomActivity(db, [step.roomId]);
      return [];
    case "upsertActivityItem":
      await upsertActivityItem(db, {
        roomId: step.roomId,
        spaceId: step.spaceId,
        messageId: step.messageId as Ulid,
        timestamp: step.timestamp,
      });
      return [];
    case "setMessageSortIdxByReorder":
      await setMessageSortIdxByReorder(
        db,
        step.streamId,
        step.messageId,
        step.after,
      );
      return [];
    case "storeLinks":
      return await storeLinks(
        db,
        globalDb,
        step.spaceId,
        step.messageId,
        step.urls,
        step.at,
      );
    case "queueLinkAttachments":
      await queueLinks(globalDb, step.spaceId, step.messageId, step.urls);
      return [...step.urls];
  }
}

/**
 * Queue URLs for the embed sweeper without writing link rows.
 *
 * An attachment's entity already exists under its per-message id, so only the
 * global pending-links index is written; `insert or ignore` collapses a URL the
 * message body also names into the row the body step stored.
 */
async function queueLinks(
  globalDb: DbLike | undefined,
  spaceId: StreamDid,
  messageId: string,
  urls: readonly string[],
): Promise<void> {
  if (!globalDb) return;
  for (const url of new Set(urls)) {
    await globalDb.run(
      `insert or ignore into pending_links (space_did, message_id, url, created_at)
       values (?, ?, ?, ?)`,
      [spaceId, messageId, url, Date.now()],
    );
  }
}

/**
 * Store a message's links: an entity row per URL, its `comp_embed_link` row,
 * and — when the caller has one — the global entity→space and pending-link
 * index entries the sweeper walks.
 *
 * Returns the URLs whose `comp_embed_link` row was newly inserted, which is the
 * set the write path prioritises in the sweeper.
 */
async function storeLinks(
  db: DbLike,
  globalDb: DbLike | undefined,
  spaceId: StreamDid,
  messageId: string,
  urls: readonly string[],
  at: number,
): Promise<string[]> {
  const stored: string[] = [];
  for (const url of urls) {
    // The link entity is scoped to the message: `room` holds the message id so
    // a read can find a message's links by it.
    await db.run(
      `insert or ignore into entities (id, stream_id, room, created_at, updated_at)
       values (?, '', ?, ?, ?)`,
      [url, messageId, at, at],
    );
    const inserted = await db.run(
      `insert or ignore into comp_embed_link (entity, show_preview, created_at, updated_at)
       values (?, 1, ?, ?)`,
      [url, at, at],
    );
    if (inserted.changes > 0) stored.push(url);
  }

  if (stored.length > 0 && globalDb) {
    // Link entities carry an empty stream_id in the per-space DB, so the global
    // index is what resolves them to this space; the pending-links index is what
    // the embed sweeper walks without opening every per-space DB. Both are
    // idempotent, so a replayed message re-writes the same rows.
    for (const url of stored) {
      await globalDb.run(
        `insert or ignore into entity_space (entity_id, space_did) values (?, ?)`,
        [url, spaceId],
      );
      await globalDb.run(
        `insert or ignore into pending_links (space_did, message_id, url, created_at)
         values (?, ?, ?, ?)`,
        [spaceId, messageId, url, Date.now()],
      );
    }
  }
  return stored;
}

/**
 * The reorder step a log entry carries, or `null` for any other entry.
 *
 * `reorderMessage` emits no record — its key is derived from the neighbours it
 * names — so the event path is the only caller. No producer emits one.
 */
export function reorderStep(
  streamId: StreamDid,
  event: Event,
): DerivedStep | null {
  if (event.$type !== "space.roomy.message.reorderMessage.v0") return null;
  const named = event as { messageId?: unknown; after?: unknown };
  if (typeof named.messageId !== "string") return null;
  if (typeof named.after !== "string") return null;
  return {
    effect: "setMessageSortIdxByReorder",
    streamId,
    messageId: named.messageId,
    after: named.after,
  };
}
