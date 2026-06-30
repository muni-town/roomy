/**
 * Push evaluation for a live `createMessage`.
 *
 * Phase 1 scope: **Busy** immediate pushes only. For a live message in
 * `roomId` (space `spaceId`) by `authorDid`:
 *   1. Resolve message facts (room name + author name for the payload).
 *   2. Enumerate recipients: space members ∪ admins.
 *   3. For each recipient whose effective level is `busy` (per-space override
 *      → user default → appserver default), confirm read access to the room
 *      and that they have ≥1 subscription, then emit an immediate push.
 *   4. Exclude the author.
 *
 * `silent` is skipped. `quiet`/`engaged` are not immediate in Phase 1:
 *   - mentions (which would make quiet/engaged immediate) land in Phase 3;
 *   - the Engaged digest lands in Phase 2.
 * Until then quiet behaves like silent and engaged runs digest-only (no
 * immediate push here). This keeps Phase 1's end-to-end (Busy) test working
 * while the digest/mention paths are built out in later phases.
 *
 * Recipients are enumerated from `edges ... label='member'` (∪ admin)
 * directly, NOT from `read_positions`, which sidesteps the lazy-row gap in
 * `applyBundle`'s unread-counter increment.
 */

import type { Database } from "bun:sqlite";
import { roomAccess } from "../auth/access.ts";
import { resolveLevel } from "../queries/pushPreferences.ts";
import { selectSubscriptions } from "../queries/pushSubscriptions.ts";
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
 * Evaluate a live createMessage job and return the immediate pushes to
 * deliver (one per recipient). Phase 1: Busy only.
 */
export function evaluatePush(db: Database, job: PushJob): PushDelivery[] {
  const { spaceId, roomId, authorDid } = job;
  const facts = resolveMessageFacts(db, roomId, authorDid);

  const candidateDids = enumerateRecipients(db, spaceId);

  const deliveries: PushDelivery[] = [];
  for (const did of candidateDids) {
    if (did === authorDid) continue; // never notify the author

    const level = resolveLevel(db, did, spaceId);
    // Phase 1: only Busy produces an immediate push.
    if (level !== "busy") continue;

    // Read-access filter (reuse the auth unit). Skip users who can't read
    // the room — never leak a notification for a room they can't open.
    const access = roomAccess(db, roomId, did);
    if (!access.canRead) continue;

    // Only enqueue if the user has at least one subscription.
    const subs = selectSubscriptions(db, did);
    if (subs.length === 0) continue;

    const payload: PushPayload = {
      type: "message",
      spaceId,
      roomId,
      messageId: job.messageId,
      count: 1,
      ...(facts.roomName != null ? { roomName: facts.roomName } : {}),
      ...(facts.authorName != null
        ? { authorName: facts.authorName }
        : {}),
    };
    deliveries.push({ userDid: did, payload });
  }

  return deliveries;
}