/**
 * Global mentions index: read/write helpers.
 *
 * The `mentions` table lives in the global DB (cross-space — a user's
 * mentions span every space they're in). It's dual-written during
 * materialization so:
 *   - a client subscribed to the `mentions:<did>` sync topic can backfill
 *     history via `space.roomy.mention.getMentions` with one query, and
 *   - deleteMessage can resolve which DIDs a deleted message mentioned.
 *
 * The DID is the stable ID (never the handle or display name).
 */
import type { DbLike } from "../db/types.ts";
import type { AppliedEvent, MessageDiffOp } from "../invalidation/types.ts";
import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import { selectMessages, type MessageDto } from "./selectMessages.ts";
import { openSpaceDb } from "../db/db.ts";

export type MentionKind = "mention" | "reply";

export interface MentionRow {
  did: UserDid;
  message_id: Ulid;
  space_did: StreamDid;
  room_id: Ulid;
  /** 'mention' (a #didMention / mentions extension) or 'reply' (depth-1 reply to this DID's message). */
  kind: MentionKind;
  created_at: number;
}

/** Options for {@link syncMentionsIndex}. */
export interface SyncMentionsIndexOpts {
  /**
   * Per-space DB handle for reply-edge resolution. When present (the
   * router passes the routed pool), createMessage/editMessage reply
   * attachments are resolved to the replied-to message's author.
   */
  spaceDb?: DbLike;
  /**
   * Pre-resolved reply-target → author map (one batched query per stream
   * via {@link resolveReplyToAuthors}). When both this and `spaceDb` are
   * provided, the map wins (callers resolve once per batch, not per event).
   */
  replyToAuthors?: ReadonlyMap<Ulid, UserDid>;
}

/**
 * Resolve the author of each reply target in one batched per-space query:
 * `reply` edges (head = replying message, tail = replied-to message) joined
 * through the replied-to message's `author` edge. Callers (the invalidation
 * router) resolve once per batch of events so the write path stays
 * batch-friendly; missing targets (deleted / not-yet-materialised) simply
 * have no entry and produce no reply row.
 */
export async function resolveReplyToAuthors(
  spaceDb: DbLike,
  messageIds: readonly Ulid[],
): Promise<Map<Ulid, UserDid>> {
  const out = new Map<Ulid, UserDid>();
  if (messageIds.length === 0) return out;
  const ph = messageIds.map(() => "?").join(",");
  const rows = await spaceDb
    .query(
      `select reply_e.head as message_id, author_e.tail as author_did
         from edges reply_e
         join edges author_e
           on author_e.head = reply_e.tail
          and author_e.label = 'author'
        where reply_e.head in (${ph})
          and reply_e.label = 'reply'`,
    )
    .all<{ message_id: string; author_did: string }>(...messageIds);
  for (const r of rows) out.set(r.message_id as Ulid, r.author_did as UserDid);
  return out;
}

/**
 * Sync the global mentions index for a batch of applied events.
 *
 * - createMessage: insert a row per mentioned DID (self-mentions included —
 *   the bridge/client filter is the customization point), plus one
 *   `kind='reply'` row for the author of the replied-to message when the
 *   event carries a reply attachment (depth-1 only — no reply-chain walk).
 *   When a replied-to author is ALSO mentioned, the single row (PK is
 *   did+message) is written as `kind='reply'` so the mention frame the
 *   client receives for the reply-to author is unambiguous.
 * - editMessage: replace the message's rows (mentions and reply target may
 *   have changed).
 * - deleteMessage: remove the message's rows.
 *
 * Callers pass the global DB handle; the per-space DB is only needed to
 * re-read a message's content for edit (not currently the case) and to
 * resolve reply-edge authors (pass `spaceDb`/`replyToAuthors` from the
 * router, which has the routed pool).
 */
export async function syncMentionsIndex(
  globalDb: DbLike,
  events: readonly AppliedEvent[],
  opts: SyncMentionsIndexOpts = {},
): Promise<void> {
  const { spaceDb, replyToAuthors } = opts;

  for (const event of events) {
    const roomId = event.roomId;
    if (!roomId) continue;

    switch (event.type) {
      case "space.roomy.message.createMessage.v0":
      case "space.roomy.message.forwardMessages.v0": {
        const mentions = event.details?.mentions as UserDid[] | undefined;
        const messageId = event.id;
        const now = Date.now();
        for (const did of mentions ?? []) {
          await insertMentionRow(globalDb, event, { did, messageId, roomId, now, kind: "mention" });
        }
        const replyAuthor = await replyAuthorFor(
          event.id,
          spaceDb,
          replyToAuthors,
        );
        if (replyAuthor && replyAuthor !== event.user) {
          await insertMentionRow(globalDb, event, {
            did: replyAuthor,
            messageId,
            roomId,
            now,
            kind: "reply",
          });
        }
        break;
      }
      case "space.roomy.message.editMessage.v0": {
        const messageId = (event.details?.messageId as Ulid | undefined) ?? event.id;
        await globalDb.run(`delete from mentions where message_id = ?`, [messageId]);
        const mentions = event.details?.mentions as UserDid[] | undefined;
        const now = Date.now();
        for (const did of mentions ?? []) {
          await insertMentionRow(globalDb, event, { did, messageId, roomId, now, kind: "mention" });
        }
        const replyAuthor = await replyAuthorFor(
          messageId,
          spaceDb,
          replyToAuthors,
        );
        if (replyAuthor && replyAuthor !== event.user) {
          await insertMentionRow(globalDb, event, {
            did: replyAuthor,
            messageId,
            roomId,
            now,
            kind: "reply",
          });
        }
        break;
      }
      case "space.roomy.message.deleteMessage.v0": {
        const messageId = (event.details?.messageId as Ulid | undefined) ?? event.id;
        await globalDb.run(`delete from mentions where message_id = ?`, [messageId]);
        break;
      }
    }
  }
}

/**
 * Resolve the replied-to message's author for a message entity id.
 * Prefers the router's pre-resolved batch map (one query per stream);
 * falls back to a per-space DB read for direct callers/tests.
 */
async function replyAuthorFor(
  messageId: Ulid,
  spaceDb: DbLike | undefined,
  replyToAuthors: ReadonlyMap<Ulid, UserDid> | undefined,
): Promise<UserDid | undefined> {
  if (replyToAuthors) return replyToAuthors.get(messageId);
  if (!spaceDb) return undefined;
  const map = await resolveReplyToAuthors(spaceDb, [messageId]);
  return map.get(messageId);
}

/**
 * Insert one mentions row. The upsert keeps the existing row on a
 * reply-over-mention overlap (the reply path runs after the mention path and
 * upgrades it via `on conflict`), so each (did, message) pair has exactly
 * one row with the most specific kind.
 *
 * NB: keys rows by the MESSAGE id — for editMessage events that is
 * `details.messageId` (the edited message), NOT the edit event's own id.
 */
async function insertMentionRow(
  globalDb: DbLike,
  event: AppliedEvent,
  args: { did: UserDid; messageId: Ulid; roomId: Ulid; now: number; kind: MentionKind },
): Promise<void> {
  const { did, messageId, roomId, now, kind } = args;
  await globalDb.run(
    `insert into mentions (did, message_id, space_did, room_id, kind, created_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict (did, message_id) do update set kind = excluded.kind`,
    [did, messageId, event.streamDid, roomId, kind, now],
  );
}

/**
 * Resolve the DIDs a message mentioned (from the global index). Used by
 * deleteMessage to emit `remove` mention ops for the right users.
 */
export async function getMentionedDidsForMessage(
  globalDb: DbLike,
  messageId: Ulid,
): Promise<UserDid[]> {
  const rows = await globalDb
    .query(`select did from mentions where message_id = ?`)
    .all<{ did: string }>([messageId]);
  return rows.map((r) => r.did as UserDid);
}

/**
 * Fetch recent mentions for a DID, newest first, with cursor pagination.
 * Returns the mention rows plus the message snapshots and space/room context.
 */
export async function getMentions(
  globalDb: DbLike,
  did: UserDid,
  limit: number,
  cursor?: string,
): Promise<{ mentions: MentionRow[]; cursor?: string }> {
  const rows = cursor
    ? await globalDb
        .query(
          `select did, message_id, space_did, room_id, kind, created_at
           from mentions
           where did = ? and created_at < ?
           order by created_at desc
           limit ?`,
        )
        .all<MentionRow>([did, Number(cursor), limit + 1])
    : await globalDb
        .query(
          `select did, message_id, space_did, room_id, kind, created_at
           from mentions
           where did = ?
           order by created_at desc
           limit ?`,
        )
        .all<MentionRow>([did, limit + 1]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0
    ? String(page[page.length - 1]!.created_at)
    : undefined;

  return { mentions: page, cursor: nextCursor };
}

/**
 * Load the full message snapshots for a set of mention rows, grouped by
 * space (each space's messages live in that space's per-space DB).
 *
 * The `mentions` table lives in the global DB, but the message rows (and the
 * `entities`/`comp_*` tables they join against) live in per-space DBs — so
 * this routes each space's message batch to that space's DB. Querying the
 * global DB here would fail with "no such table: entities".
 */
export async function loadMentionMessages(
  rows: MentionRow[],
): Promise<Map<Ulid, MessageDto>> {
  const bySpace = new Map<StreamDid, Ulid[]>();
  for (const row of rows) {
    const ids = bySpace.get(row.space_did) ?? [];
    ids.push(row.message_id);
    bySpace.set(row.space_did, ids);
  }
  const out = new Map<Ulid, MessageDto>();
  for (const [spaceDid, ids] of bySpace) {
    const { messages } = await selectMessages(openSpaceDb(spaceDid), {
      kind: "ids",
      ids,
    });
    for (const m of messages) out.set(m.id as Ulid, m);
  }
  return out;
}
