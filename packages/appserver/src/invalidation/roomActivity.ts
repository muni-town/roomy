/**
 * Build the `RoomActivityDiff` a newly-applied message implies.
 *
 * The board views (`space.getThreads`, `room.getThreads`) and
 * `room.getMetadata.recentThreads` are ordered by each room's latest activity,
 * so a new message reorders them. Expressing that as a per-message
 * `#invalidate` for each of those endpoints would make every reader refetch
 * every board on every message, so the diff below carries only the facts that
 * changed instead.
 *
 * The facts that actually changed are small and identical for all readers:
 * which room, its latest timestamp, and which participants are most recent.
 * This module derives exactly those from the message the materialiser just
 * wrote, in the shape the board handlers return (`ThreadActivity` in
 * `queries/threadActivity.ts`), so the client can upsert-and-move-to-front
 * instead of refetching.
 *
 * What is deliberately NOT here:
 *   - `unreadCount` / `unread` / `lastRead` — caller-scoped; `RoomMetadataDiff`
 *     already carries the unread delta per user.
 *   - the whole `latestMembers` aggregate — the board's list is the room's 3
 *     newest distinct authors, and one new message can only move its own author
 *     to the front, so the diff carries that one author and the client merges
 *     (dedupe by DID, cap 3). Re-deriving it server-side would re-run the
 *     aggregate `fetchRoomActivity` exists to batch.
 */

import type { StreamDid, Ulid } from "@roomy-space/sdk";
import { RICHTEXT_MIME, blocksToPlaintext } from "@roomy-space/sdk";
import type { DbLike } from "../db/types.ts";
import { decodeRichTextBody } from "../db/content.ts";
import type { MessageDto } from "../queries/selectMessages.ts";
import type { RoomActivityDiff } from "./types.ts";

/**
 * Structural facts about a room that the board row needs: its kind, its name,
 * and its canonical parent channel.
 */
export interface RoomBoardFacts {
  kind: "thread" | "channel";
  name?: string;
  parentChannelId?: string;
  parentChannelName?: string;
}

/**
 * Read a room's board facts. One query, the same shape `insertActivityItem`
 * uses on its first-insert path: the label decides thread vs channel, and the
 * canonical `link` edge (when present) gives the parent channel and its name.
 */
export async function readRoomBoardFacts(
  db: DbLike,
  roomId: string,
): Promise<RoomBoardFacts> {
  const row = await db
    .query(
      `select cr.label as label,
              ci.name as name,
              parent_e.head as parent_id,
              parent_ci.name as parent_name
         from comp_room cr
         left join comp_info ci on ci.entity = cr.entity
         left join edges parent_e
           on parent_e.tail = cr.entity
           and parent_e.label = 'link'
           and coalesce(json_extract(parent_e.payload, '$.canonical_parent'), 0) = 1
         left join comp_info parent_ci on parent_ci.entity = parent_e.head
        where cr.entity = ?`,
    )
    .get<{
      label: string | null;
      name: string | null;
      parent_id: string | null;
      parent_name: string | null;
    }>(roomId);

  const isThread = row?.label === "space.roomy.thread";
  return {
    kind: isThread ? "thread" : "channel",
    ...(row?.name != null ? { name: row.name } : {}),
    ...(isThread && row?.parent_id != null
      ? {
          parentChannelId: row.parent_id,
          ...(row.parent_name != null ? { parentChannelName: row.parent_name } : {}),
        }
      : {}),
  };
}

/**
 * Decode a message body to the plaintext the board preview renders.
 *
 * `MessageDto.content` is the wire form: raw text for legacy `text/*` bodies,
 * and base64-encoded blocks JSON for richtext ones (see `decodeContent`). The
 * board handler (`fetchRoomActivity`) renders richtext via
 * `blocksToPlaintext`, so the diff must carry the same plaintext or the
 * client's patched row would show an encoded blob where a refetched row shows
 * readable text.
 */
export function boardPreviewText(message: MessageDto): string {
  if (message.mimeType === RICHTEXT_MIME) {
    const blocks = decodeRichTextBody(
      message.mimeType,
      Buffer.from(message.content, "base64"),
    );
    return blocks ? blocksToPlaintext(blocks) : "";
  }
  return message.content;
}

/**
 * Build the activity diff for a message that just landed in `roomId`.
 *
 * `message` is the post-materialisation row (`selectMessages`), so its author
 * fields are already hydrated from the global profile store — the same values
 * a board read would return.
 */
export function roomActivityDiff(
  spaceId: StreamDid,
  roomId: Ulid,
  facts: RoomBoardFacts,
  message: MessageDto,
): RoomActivityDiff {
  const author = {
    did: message.authorDid,
    name: message.authorName ?? null,
    avatar: message.authorAvatar ?? null,
  };
  const timestamp = message.timestamp || undefined;

  return {
    spaceId,
    roomId,
    kind: facts.kind,
    ...(facts.name != null ? { name: facts.name } : {}),
    ...(facts.parentChannelId != null
      ? { parentChannelId: facts.parentChannelId }
      : {}),
    ...(facts.parentChannelName != null
      ? { parentChannelName: facts.parentChannelName }
      : {}),
    activity: {
      ...(timestamp != null ? { latestTimestamp: timestamp } : {}),
      latestMembers: [author],
      latestMessage: {
        id: message.id,
        content: boardPreviewText(message),
        author,
        ...(timestamp != null ? { timestamp } : {}),
      },
    },
  };
}
