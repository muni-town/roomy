/**
 * Push evaluation for a live `createMessage`.
 *
 * Phase 2 scope: **Busy** immediate pushes AND the **Engaged digest** path.
 * For a live message in `roomId` (space `spaceId`) by `authorDid`:
 *   1. Resolve message facts (room name + author name for the payload).
 *   2. Enumerate recipients: space members ∪ admins.
 *   3. For each recipient (excluding the author), resolve their effective
 *      level (per-space override → user default → appserver default), then:
 *      - `silent`  → skip.
 *      - `quiet`   → skip (mentions land in Phase 3; until then quiet == silent).
 *      - `busy`    → immediate `message` push (one per message).
 *      - `engaged` → digest path:
 *          * read-access filter (never notify for a room they can't read);
 *          * subscription check (≥1 device);
 *          * participation gate — only rooms the recipient has sent a message
 *            in (lazy-backfilled once per user+space);
 *          * upsert `notification_state` for (recipient, room): count this
 *            message, keep the earliest `first_unseen_at`, and if the batch
 *            reaches 5 unseen → mark `notified` and emit a `digest` push now.
 *          * if below threshold, no delivery is emitted here — the dispatcher's
 *            periodic sweep catches batches whose 1h timer elapses.
 *
 * `updateSeen` (room open) deletes the `notification_state` row, re-arming the
 * batch. One push per room per batch is enforced by the `notified` flag.
 *
 * Recipients are enumerated from `edges ... label='member'` (∪ admin)
 * directly, NOT from `read_positions`, which sidesteps the lazy-row gap in
 * `applyBundle`'s unread-counter increment.
 *
 * Returns two kinds of {@link PushDelivery}: immediate `message` pushes
 * (Busy) and on-event `digest` pushes (Engaged threshold). Time-based digests
 * are emitted by the dispatcher sweep, not here.
 */

import type { Database } from "bun:sqlite";
import { roomAccess } from "../auth/access.ts";
import { resolveLevel } from "../queries/pushPreferences.ts";
import { selectSubscriptions } from "../queries/pushSubscriptions.ts";
import { upsertNotificationState } from "../queries/notificationState.ts";
import { hasUserParticipatedInSpace } from "../queries/userRoomParticipation.ts";
import { resolveMessageIcon } from "./avatars.ts";
import { log } from "../log.ts";
import type { PushDelivery, PushJob, PushPayload } from "./types.ts";

export interface MessageFacts {
  roomName: string | null;
  authorName: string | null;
}

/**
 * Resolve the room + author display names for the payload. Per the plan's
 * recommendation (open question #4) we send names only, not message content,
 * so nothing the recipient can't already read traverses the push service.
 */
export function resolveMessageFacts(
  db: Database,
  roomId: string,
  authorDid: string,
): MessageFacts {
  const roomRow = db
    .query<{ name: string | null }, [string]>(
      "select name from comp_info where entity = ?",
    )
    .get(roomId);
  const roomName = roomRow?.name ?? null;

  const authorRow = db
    .query<
      { name: string | null; handle: string | null },
      [string, string]
    >(
      `select ci.name as name, cu.handle as handle
         from (select 1) _
         left join comp_info ci on ci.entity = ?
         left join comp_user cu on cu.did = ?`,
    )
    .get(authorDid, authorDid);
  const authorName = authorRow?.name ?? authorRow?.handle ?? null;

  return { roomName, authorName };
}

/**
 * Enumerate candidate recipient DIDs for a space: members ∪ admins.
 * (Admins who are also members are de-duplicated.)
 */
export function enumerateRecipients(
  db: Database,
  spaceId: string,
): string[] {
  const rows = db
    .query<{ did: string }, [string]>(
      `select distinct tail as did from edges
        where head = ? and label in ('member', 'admin')`,
    )
    .all(spaceId);
  return rows.map((r) => r.did);
}

/**
 * Evaluate a live createMessage job and return the pushes to deliver (one per
 * recipient). Busy emits an immediate `message` push; Engaged emits an
 * on-event `digest` push when the 5-message threshold is reached (and records
 * digest state for the sweep to catch the 1-hour threshold otherwise).
 */
export function evaluatePush(db: Database, job: PushJob): PushDelivery[] {
  const { spaceId, roomId, authorDid, messageId, timestamp } = job;
  const facts = resolveMessageFacts(db, roomId, authorDid);

  // Icon is recipient-independent → resolve once per message. Both message and
  // on-event digest pushes use the sender avatar → space avatar (per the plan:
  // "user avatars, or failing that, space avatars").
  const icon = resolveMessageIcon(db, authorDid, spaceId);
  if (icon) {
    log.info(`[push-evaluate] icon resolved for ${messageId}: ${icon}`);
  } else {
    log.debug(`[push-evaluate] no icon for ${messageId} (author=${authorDid.slice(0, 30)}… space=${spaceId.slice(0, 30)}…)`);
  }

  const candidateDids = enumerateRecipients(db, spaceId);

  const deliveries: PushDelivery[] = [];
  for (const did of candidateDids) {
    if (did === authorDid) continue; // never notify the author

    const level = resolveLevel(db, did, spaceId);
    if (level === "silent" || level === "quiet") {
      // quiet has no mentions path yet (Phase 3) → behaves like silent.
      continue;
    }

    // Read-access filter (reuse the auth unit). Skip users who can't read
    // the room — never leak a notification for a room they can't open.
    const access = roomAccess(db, roomId, did);
    if (!access.canRead) continue;

    // Only enqueue if the user has at least one subscription.
    const subs = selectSubscriptions(db, did);
    if (subs.length === 0) continue;

    if (level === "busy") {
      const payload: PushPayload = {
        type: "message",
        spaceId,
        roomId,
        messageId,
        count: 1,
        ...(facts.roomName != null ? { roomName: facts.roomName } : {}),
        ...(facts.authorName != null
          ? { authorName: facts.authorName }
          : {}),
      };
      if (icon) payload.icon = icon;
      deliveries.push({ userDid: did, payload });
      continue;
    }

    // level === "engaged" → digest path.
    // Participation gate: only rooms the recipient has sent a message in.
    // (Lazy-backfilled once per user+space so the gate works for existing
    // users without them sending a new message first.)
    if (!hasUserParticipatedInSpace(db, did, spaceId, roomId)) continue;

    const outcome = upsertNotificationState(db, did, roomId, timestamp, messageId);
    if (!outcome.fireNow) continue; // below threshold; sweep catches the 1h timer

    const payload: PushPayload = {
      type: "digest",
      spaceId,
      roomId,
      count: outcome.unseenCount,
      ...(facts.roomName != null ? { roomName: facts.roomName } : {}),
    };
    if (icon) payload.icon = icon;
    deliveries.push({ userDid: did, payload });
  }

  return deliveries;
}