/**
 * Per-(user, room) digest state for the Engaged "occasional prompts".
 *
 * One row = one pending/fulfilled batch of unseen messages since the user last
 * opened the room. The Engaged digest path (see `push/evaluate.ts`) upserts a
 * row on every live `createMessage` it doesn't immediately push for; the
 * 5-message threshold fires on the spot, and the 1-hour threshold is caught by
 * the dispatcher's periodic sweep. `updateSeen` deletes the row — "until you
 * open the room again".
 *
 * State lives in the read-state DB so it survives materialisation resets.
 */

import type { Database } from "bun:sqlite";

/** How many unseen messages in a room trigger an immediate (on-event) digest. */
export const DIGEST_THRESHOLD = 5;

/** How long after the first unseen message before a time-based digest fires. */
export const DIGEST_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export interface NotificationStateRow {
  userDid: string;
  roomId: string;
  firstUnseenAt: number | null;
  firstUnseenMsgId: string | null;
  unseenCount: number;
  notified: 0 | 1;
  pushedAt: number | null;
}

/**
 * Outcome of upserting a new unseen message into a room's digest state.
 *  - `fireNow: true`  — the on-event threshold (5 messages) was just reached;
 *    the caller should fire a digest push and the row is already marked
 *    `notified = 1` so the batch won't fire again.
 *  - `fireNow: false` — either the batch is still below threshold, or a digest
 *    has already gone out for this batch (`notified = 1`) and we stay quiet
 *    until the user reopens the room (which deletes the row).
 */
export interface UpsertDigestOutcome {
  fireNow: boolean;
  unseenCount: number;
}

/**
 * Record a new unseen message for `(userDid, roomId)` and decide whether the
 * on-event digest threshold is met. Idempotent per batch: once `notified = 1`,
 * further messages in the same batch are counted but never re-trigger a push.
 *
 * `msgTimestamp` is the message's epoch-ms timestamp (from `decodeTime(messageId)`).
 */
export function upsertNotificationState(
  db: Database,
  userDid: string,
  roomId: string,
  msgTimestamp: number,
  msgId: string,
): UpsertDigestOutcome {
  const existing = db
    .query<{ unseen_count: number; notified: 0 | 1 }, [string, string]>(
      "select unseen_count, notified from readstate.notification_state where user_did = ? and room_id = ?",
    )
    .get(userDid, roomId);

  // No row → start a fresh batch.
  if (!existing) {
    db.prepare(
      `insert into readstate.notification_state
         (user_did, room_id, first_unseen_at, first_unseen_msg_id, unseen_count, notified, updated_at)
       values (?, ?, ?, ?, 1, 0, (unixepoch() * 1000))`,
    ).run(userDid, roomId, msgTimestamp, msgId);
    return { fireNow: false, unseenCount: 1 };
  }

  // Already notified for this batch — stay quiet until the room is reopened.
  if (existing.notified === 1) {
    return { fireNow: false, unseenCount: existing.unseen_count };
  }

  // Still accumulating: count this message, keep the earliest first_unseen_at.
  const newCount = existing.unseen_count + 1;
  if (newCount >= DIGEST_THRESHOLD) {
    // Threshold reached — fire now, and mark notified so the batch won't
    // fire again (on-event or sweep). The caller delivers the push.
    db.prepare(
      `update readstate.notification_state
          set unseen_count = ?, notified = 1, pushed_at = (unixepoch() * 1000), updated_at = (unixepoch() * 1000)
        where user_did = ? and room_id = ?`,
    ).run(newCount, userDid, roomId);
    return { fireNow: true, unseenCount: newCount };
  }

  db.prepare(
    `update readstate.notification_state
        set unseen_count = ?, updated_at = (unixepoch() * 1000)
      where user_did = ? and room_id = ?`,
  ).run(newCount, userDid, roomId);
  return { fireNow: false, unseenCount: newCount };
}

/**
 * Select digest rows whose 1-hour timer has elapsed but haven't fired yet, for
 * the dispatcher's periodic sweep. Returns at most `limit` rows (oldest first)
 * so a large backlog drains gradually rather than flooding the push service.
 */
export function selectDueDigests(
  db: Database,
  now: number,
  limit: number,
): NotificationStateRow[] {
  const cutoff = now - DIGEST_WINDOW_MS;
  const rows = db
    .query<
      {
        user_did: string;
        room_id: string;
        first_unseen_at: number | null;
        first_unseen_msg_id: string | null;
        unseen_count: number;
        notified: 0 | 1;
        pushed_at: number | null;
      },
      [number, number]
    >(
      `select user_did, room_id, first_unseen_at, first_unseen_msg_id,
              unseen_count, notified, pushed_at
         from readstate.notification_state
        where notified = 0
          and first_unseen_at is not null
          and first_unseen_at <= ?
        order by first_unseen_at asc
        limit ?`,
    )
    .all(cutoff, limit);
  return rows.map((r) => ({
    userDid: r.user_did,
    roomId: r.room_id,
    firstUnseenAt: r.first_unseen_at,
    firstUnseenMsgId: r.first_unseen_msg_id,
    unseenCount: r.unseen_count,
    notified: r.notified,
    pushedAt: r.pushed_at,
  }));
}

/**
 * Mark a digest row as notified (a push has been dispatched for this batch).
 * Used by the sweep after it fires a time-based digest. The on-event path
 * marks notified inline in {@link upsertNotificationState}.
 */
export function markNotified(
  db: Database,
  userDid: string,
  roomId: string,
): void {
  db.prepare(
    `update readstate.notification_state
        set notified = 1, pushed_at = (unixepoch() * 1000), updated_at = (unixepoch() * 1000)
      where user_did = ? and room_id = ?`,
  ).run(userDid, roomId);
}

/**
 * Reset (delete) the digest state for `(userDid, roomId)` — called by the
 * `updateSeen` handler when the user opens/reads the room. This cancels any
 * pending digest and re-arms the batch for the next burst ("until you open the
 * room again"). Idempotent: no row = no-op.
 */
export function resetNotificationState(
  db: Database,
  userDid: string,
  roomId: string,
): void {
  db.prepare(
    "delete from readstate.notification_state where user_did = ? and room_id = ?",
  ).run(userDid, roomId);
}