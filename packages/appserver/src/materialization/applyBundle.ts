/**
 * Apply a single materialised event's SQL statements to the database.
 *
 * Each event runs inside its own SAVEPOINT so a single failing event rolls
 * back cleanly without poisoning the rest of the batch. This is stricter than
 * the frontend's per-statement error tolerance: the appserver treats partial
 * application as a bug, not a feature.
 *
 * Side-effects (sort_idx, unread counter) live here rather than inside the SDK
 * materialisers because the original design keeps materialisers free of
 * backfill awareness.
 */

import { Database } from "bun:sqlite";
import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import type { SqlStatement, StatementBundleSuccess } from "./types.ts";
import {
  setMessageSortIdxByForward,
  setMessageSortIdxByReorder,
  setMessageSortIdxByTimestamp,
} from "./sortIdx.ts";
import { isThread, upsertUserThreadActivity } from "../queries/userActiveThreads.ts";
import { upsertUserRoomParticipation } from "../queries/userRoomParticipation.ts";
import { upsertActivityItem } from "./activityItem.ts";
import { decodeTime } from "ulidx";

const decodeTimeFromId = (id: string): number => decodeTime(id);

/**
 * Resolve the effective author DID for a message: the authorOverride
 * extension's `did` if present (bridged messages), else the authenticated
 * stream `user`. Matches the `author` edge logic and `toAppliedEvent`'s
 * `details.authorDid`. Only meaningful for `createMessage` events (the sole
 * caller guards on that), so we narrow the union to access `extensions`.
 */
function effectiveAuthorDid(bundle: StatementBundleSuccess): string {
  if (bundle.event.$type !== "space.roomy.message.createMessage.v0") {
    return bundle.user;
  }
  const ext = bundle.event.extensions?.["space.roomy.extension.authorOverride.v0"];
  const overrideDid = (ext as { did?: string } | undefined)?.did;
  return overrideDid ?? bundle.user;
}

export interface ApplyBundleOpts {
  /** True for backfill events — skips the unread-counter increment. */
  isBackfill: boolean;
  streamId: StreamDid;
}

export function applyBundle(
  db: Database,
  bundle: StatementBundleSuccess,
  opts: ApplyBundleOpts,
): void {
  const savepoint = `evt_${bundle.event.id.replace(/[^a-zA-Z0-9]/g, "")}`;
  db.exec(`savepoint ${savepoint}`);

  try {
    for (const statement of bundle.statements) {
      runStatement(db, statement);
    }

    setMessageSortIdxByTimestamp(db, bundle.event);
    setMessageSortIdxByReorder(db, opts.streamId, bundle.event);
    setMessageSortIdxByForward(db, bundle.event);

    // Activity feed: upsert the activity item for every createMessage event
    // (including backfill, so existing rooms get populated).
    if (
      bundle.event.$type === "space.roomy.message.createMessage.v0" &&
      bundle.event.room
    ) {
      upsertActivityItem(db, {
        roomId: bundle.event.room,
        spaceId: opts.streamId,
        messageId: bundle.event.id,
      });
    }

    if (
      !opts.isBackfill &&
      bundle.event.$type === "space.roomy.message.createMessage.v0" &&
      bundle.event.room
    ) {
      // Increment unread for all users tracking this room. Replaces the old
      // per-room comp_last_read counter with per-user read_positions rows.
      db.prepare(
        `update readstate.read_positions
            set unread_count = unread_count + 1,
                updated_at = (unixepoch() * 1000)
          where room_id = ?`,
      ).run(bundle.event.room);

      // Track the author's participation in this room (all room types —
      // channels included). The Engaged digest gate uses this to restrict
      // prompts to rooms you've spoken in. Uses the effective author
      // (override-author for bridged messages) to match the `author` edge.
      const authorDid = effectiveAuthorDid(bundle);
      const timestamp = decodeTimeFromId(bundle.event.id);
      upsertUserRoomParticipation(db, authorDid, bundle.event.room, timestamp);

      // Track thread activity: if the message is in a thread, upsert the
      // author's interaction so the thread appears in their sidebar.
      if (isThread(db, bundle.event.room)) {
        upsertUserThreadActivity(db, bundle.user, bundle.event.room, timestamp);
      }
    }

    // Track thread creation: if the event creates a thread, register the
    // creating user's activity so the thread appears in their sidebar
    // immediately, without needing to send a message first.
    if (
      !opts.isBackfill &&
      bundle.event.$type === "space.roomy.room.createRoom.v0" &&
      "kind" in bundle.event &&
      bundle.event.kind === "space.roomy.thread"
    ) {
      const timestamp = decodeTimeFromId(bundle.event.id);
      upsertUserThreadActivity(db, bundle.user, bundle.event.id, timestamp);
    }

    // Track reaction activity in threads (non-backfill only).
    if (
      !opts.isBackfill &&
      (bundle.event.$type === "space.roomy.reaction.addReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.addBridgedReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.removeReaction.v0" ||
       bundle.event.$type === "space.roomy.reaction.removeBridgedReaction.v0") &&
      bundle.event.room
    ) {
      if (isThread(db, bundle.event.room)) {
        const timestamp = decodeTimeFromId(bundle.event.id);
        // For bridged reactions, use the reactingUser field instead of the
        // authenticated event sender.
        const reactingUser =
          "reactingUser" in bundle.event && typeof bundle.event.reactingUser === "string"
            ? bundle.event.reactingUser
            : bundle.user;
        upsertUserThreadActivity(db, reactingUser, bundle.event.room, timestamp);
      }
    }

    db.exec(`release ${savepoint}`);
  } catch (e) {
    db.exec(`rollback to ${savepoint}`);
    db.exec(`release ${savepoint}`);
    throw e;
  }
}

function runStatement(db: Database, statement: SqlStatement): void {
  const stmt = db.prepare(statement.sql);
  const params = statement.params;
  if (params === undefined) {
    stmt.run();
  } else if (Array.isArray(params)) {
    stmt.run(...(params as unknown[] as never[]));
  } else {
    stmt.run(params as never);
  }
}
