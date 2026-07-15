/**
 * Push evaluation for a live `createMessage`.
 *
 * Phase 3 scope: **Mentions** — Quiet and Engaged recipients who are mentioned
 * in the message get an immediate `message` push instead of being skipped
 * (quiet) or routed to the digest path (engaged).
 *
 * For a live message in `roomId` (space `spaceId`) by `authorDid`:
 *   1. Resolve message facts (room name + author name for the payload).
 *   2. Enumerate recipients: space members ∪ admins.
 *   3. For each recipient (excluding the author), resolve their effective
 *      level (per-space override → user default → appserver default), then:
 *      - `silent`  → skip.
 *      - `quiet`   → mentioned ? immediate `message` push : skip.
 *      - `busy`    → immediate `message` push (one per message).
 *      - `engaged` → mentioned ? immediate `message` push : digest path:
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
 * (Busy, quiet+mentioned, engaged+mentioned) and on-event `digest` pushes
 * (Engaged threshold). Time-based digests are emitted by the dispatcher sweep,
 * not here.
 */

import { stripMarkdownToPlaintext } from "./plaintext.ts";
import type { DbLike } from "../db/types.ts";
import { decodeContent } from "../db/content.ts";
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
  /** Decoded message text content (first ~120 chars). */
  messageContent: string | null;
}

/**
 * Resolve the room + author display names and message content for the payload.
 * Message content is truncated to ~120 characters to keep the encrypted payload
 * small — the push service never sees the plaintext, but the payload is still
 * transmitted over the wire inside the encrypted envelope.
 */
export async function resolveMessageFacts(
  db: DbLike,
  roomId: string,
  authorDid: string,
  messageId: string,
): Promise<MessageFacts> {
  const roomRow = await db.query(
    "select name from comp_info where entity = ?",
  ).get<{ name: string | null }>(roomId);
  const roomName = roomRow?.name ?? null;

  const authorRow = await db.query(
    `select ci.name as name, cu.handle as handle
       from (select 1) _
       left join comp_info ci on ci.entity = ?
       left join comp_user cu on cu.did = ?`,
  ).get<{ name: string | null; handle: string | null }>(authorDid, authorDid);
  const authorName = authorRow?.name ?? authorRow?.handle ?? null;

  // Fetch message content from comp_content, truncated to ~120 chars.
  const contentRow = await db.query(
    "select mime_type, data from comp_content where entity = ?",
  ).get<{ mime_type: string | null; data: Buffer | Uint8Array | null }>(messageId);
  let messageContent: string | null = null;
  if (contentRow?.data) {
    const raw = decodeContent(contentRow.mime_type, contentRow.data);
    messageContent = stripMarkdownToPlaintext(raw);
    if (messageContent.length > 120) {
      messageContent = messageContent.slice(0, 120) + "\u2026";
    }
  }
  return { roomName, authorName, messageContent };
}

/**
 * Enumerate candidate recipient DIDs for a space: members ∪ admins.
 * (Admins who are also members are de-duplicated.)
 */
export async function enumerateRecipients(
  db: DbLike,
  spaceId: string,
): Promise<string[]> {
  const rows = await db.query(
    `select distinct tail as did from edges
      where head = ? and label in ('member', 'admin')`,
  ).all<{ did: string }>(spaceId);
  return rows.map((r) => r.did);
}

/**
 * Build a `message`-type push payload for an immediate push (busy, quiet+mentioned,
 * engaged+mentioned). Shared across all three paths to avoid duplication.
 */
function buildMessagePayload(
  job: PushJob,
  facts: MessageFacts,
  icon: string | undefined,
): PushPayload {
  const payload: PushPayload = {
    type: "message",
    spaceId: job.spaceId,
    roomId: job.roomId,
    messageId: job.messageId,
    count: 1,
    ...(facts.roomName != null ? { roomName: facts.roomName } : {}),
    ...(facts.authorName != null
      ? { authorName: facts.authorName }
      : {}),
    ...(facts.messageContent != null
      ? { messageContent: facts.messageContent }
      : {}),
  };
  if (icon) payload.icon = icon;
  return payload;
}

/**
 * Evaluate a live createMessage job and return the pushes to deliver (one per
 * recipient). Busy emits an immediate `message` push; Engaged emits an
 * on-event `digest` push when the 5-message threshold is reached (and records
 * digest state for the sweep to catch the 1-hour threshold otherwise).
 *
 * Phase 3 (mentions): Quiet and Engaged recipients who are mentioned in the
 * message get an immediate `message` push instead of being skipped (quiet) or
 * routed to the digest path (engaged).
 */
export async function evaluatePush(
  db: DbLike,
  job: PushJob,
): Promise<PushDelivery[]> {
  const { spaceId, roomId, authorDid, messageId, timestamp, mentions } = job;
  const facts = await resolveMessageFacts(db, roomId, authorDid, messageId);
  log.info(`[push-evaluate] messageContent for ${messageId}: ${facts.messageContent ? facts.messageContent.slice(0, 60) + "…" : "null"}`);

  // Icon is recipient-independent → resolve once per message. Both message and
  // on-event digest pushes use the sender avatar → space avatar (per the plan:
  // "user avatars, or failing that, space avatars").
  const icon = await resolveMessageIcon(db, authorDid, spaceId);
  if (icon) {
    log.info(`[push-evaluate] icon resolved for ${messageId}: ${icon}`);
  } else {
    log.debug(`[push-evaluate] no icon for ${messageId} (author=${authorDid.slice(0, 30)}… space=${spaceId.slice(0, 30)}…)`);
  }

  const candidateDids = await enumerateRecipients(db, spaceId);

  const deliveries: PushDelivery[] = [];
  for (const did of candidateDids) {
    if (did === authorDid) continue; // never notify the author

    const level = await resolveLevel(db, did, spaceId);
    if (level === "silent") continue;

    // Read-access filter (reuse the auth unit). Skip users who can't read
    // the room — never leak a notification for a room they can't open.
    const access = await roomAccess(db, roomId, did);
    if (!access.canRead) continue;

    // Only enqueue if the user has at least one subscription.
    const subs = await selectSubscriptions(db, did);
    if (subs.length === 0) continue;

    // Phase 3: mention detection. Check if this recipient was mentioned.
    const mentioned = mentions?.includes(did) ?? false;

    // Immediate push paths: busy always, quiet+mentioned, engaged+mentioned.
    if (level === "busy" || (level === "quiet" && mentioned) || (level === "engaged" && mentioned)) {
      deliveries.push({ userDid: did, payload: buildMessagePayload(job, facts, icon) });
      continue;
    }

    // Quiet (not mentioned) → skip (behaves like silent).
    if (level === "quiet") continue;

    // level === "engaged", not mentioned → digest path.
    // Participation gate: only rooms the recipient has sent a message in.
    // (Lazy-backfilled once per user+space so the gate works for existing
    // users without them sending a new message first.)
    if (!(await hasUserParticipatedInSpace(db, did, spaceId, roomId))) continue;

    const outcome = await upsertNotificationState(db, did, roomId, timestamp, messageId);
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
