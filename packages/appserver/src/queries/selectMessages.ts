/**
 * Message selection helper used by `room.getMessages` and `message.getMessage`.
 *
 * Returns fully denormalised message objects with all joins resolved
 * server-side: author, content, replyTo, forwardedFrom, reactions, media, tags.
 *
 * Strategy: 1 query for the message rows + singleton-edge joins (author,
 * reply, forward), then 4 small batch queries (reactions, tags, image+video+
 * file+link embeds) keyed on the page's IDs. Constant query count, regardless
 * of page size.
 *
 * The caller is responsible for authorisation — this helper does not check
 * read access.
 */

import type { Database } from "bun:sqlite";
import { stripNulls } from "../xrpc/strip-nulls.ts";

export interface ReactionDto {
  emoji: string;
  dids: string[];
  /** reaction_id of the viewer's own reaction for this emoji; absent when not reacted. */
  myReactionId?: string;
}

export interface MessageDto {
  id: string;
  /** Sort index for timeline ordering. ULID based on canonical timestamp. */
  sort_idx?: string;
  content: string;
  authorDid: string;
  authorName: string;
  authorAvatar?: string;
  timestamp: string;
  replyTo?: string;
  forwardedFrom?: { name: string; roomId: string };
  reactions: Array<ReactionDto>;
  media: Array<{ url: string; type: string; alt?: string }>;
  tags: string[];
}

export type SelectScope =
  | { kind: "room"; roomId: string; limit: number; cursor: string | null }
  | { kind: "ids"; ids: string[] };

interface BaseRow {
  id: string;
  sort_idx: string | null;
  room: string | null;
  mime_type: string | null;
  data: Buffer | Uint8Array | null;
  timestamp: number | null;
  author_did: string | null;
  author_name: string | null;
  author_avatar: string | null;
  reply_to: string | null;
  forward_target: string | null;
  forward_target_room: string | null;
  forward_target_room_name: string | null;
}

export function selectMessages(
  db: Database,
  scope: SelectScope,
  viewerDid?: string,
): { messages: MessageDto[]; nextCursor: string | null } {
  // ── Step 1: pull the base rows ────────────────────────────────────────
  let baseRows: BaseRow[];
  if (scope.kind === "room") {
    const sql = `
      select
        e.id as id,
        e.sort_idx as sort_idx,
        e.room as room,
        cc.mime_type as mime_type,
        cc.data as data,
        cc.timestamp as timestamp,
        author_e.tail as author_did,
        author_info.name as author_name,
        author_info.avatar as author_avatar,
        reply_e.tail as reply_to,
        forward_e.tail as forward_target,
        forward_target_entity.room as forward_target_room,
        forward_target_room_info.name as forward_target_room_name
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges author_e
        on author_e.head = e.id and author_e.label = 'author'
      left join comp_info author_info on author_info.entity = author_e.tail
      left join edges reply_e
        on reply_e.head = e.id and reply_e.label = 'reply'
      left join edges forward_e
        on forward_e.head = e.id and forward_e.label = 'forward'
      left join entities forward_target_entity
        on forward_target_entity.id = forward_e.tail
      left join comp_info forward_target_room_info
        on forward_target_room_info.entity = forward_target_entity.room
      where e.room = ?1
        and (cc.entity is not null or forward_e.tail is not null)
        ${scope.cursor ? "and e.id < ?2" : ""}
      order by coalesce(e.sort_idx, e.id) desc
      limit ${Math.max(1, Math.min(scope.limit, 100))}
    `;
    const stmt = db.query<BaseRow, string[]>(sql);
    baseRows = scope.cursor
      ? stmt.all(scope.roomId, scope.cursor)
      : stmt.all(scope.roomId);
  } else {
    if (scope.ids.length === 0) {
      return { messages: [], nextCursor: null };
    }
    const placeholders = scope.ids.map(() => "?").join(",");
    baseRows = db
      .query<BaseRow, string[]>(
        `
        select
          e.id as id,
          e.sort_idx as sort_idx,
          e.room as room,
          cc.mime_type as mime_type,
          cc.data as data,
          cc.timestamp as timestamp,
          author_e.tail as author_did,
          author_info.name as author_name,
          author_info.avatar as author_avatar,
          reply_e.tail as reply_to,
          forward_e.tail as forward_target,
          forward_target_entity.room as forward_target_room,
          forward_target_room_info.name as forward_target_room_name
        from entities e
        left join comp_content cc on cc.entity = e.id
        left join edges author_e
          on author_e.head = e.id and author_e.label = 'author'
        left join comp_info author_info on author_info.entity = author_e.tail
        left join edges reply_e
          on reply_e.head = e.id and reply_e.label = 'reply'
        left join edges forward_e
          on forward_e.head = e.id and forward_e.label = 'forward'
        left join entities forward_target_entity
          on forward_target_entity.id = forward_e.tail
        left join comp_info forward_target_room_info
          on forward_target_room_info.entity = forward_target_entity.room
        where e.id in (${placeholders})
        `,
      )
      .all(...scope.ids);
  }

  if (baseRows.length === 0) return { messages: [], nextCursor: null };

  const ids = baseRows.map((r) => r.id);

  // ── Step 2: forwarded-message body resolution ─────────────────────────
  // For rows whose own `data` is null but have a `forward_target`, fetch the
  // original message's content and author and substitute.
  const forwardTargets = baseRows
    .filter((r) => r.data === null && r.forward_target)
    .map((r) => r.forward_target!) as string[];

  const forwardOrig = new Map<
    string,
    {
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      timestamp: number | null;
      author_did: string | null;
      author_name: string | null;
      author_avatar: string | null;
    }
  >();
  if (forwardTargets.length > 0) {
    const ph = forwardTargets.map(() => "?").join(",");
    const rows = db
      .query<
        {
          id: string;
          mime_type: string | null;
          data: Buffer | Uint8Array | null;
          timestamp: number | null;
          author_did: string | null;
          author_name: string | null;
          author_avatar: string | null;
        },
        string[]
      >(
        `select
           e.id as id,
           cc.mime_type as mime_type,
           cc.data as data,
           cc.timestamp as timestamp,
           author_e.tail as author_did,
           author_info.name as author_name,
           author_info.avatar as author_avatar
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges author_e
           on author_e.head = e.id and author_e.label = 'author'
         left join comp_info author_info on author_info.entity = author_e.tail
         where e.id in (${ph})`,
      )
      .all(...forwardTargets);
    for (const r of rows) {
      forwardOrig.set(r.id, {
        mime_type: r.mime_type,
        data: r.data,
        timestamp: r.timestamp,
        author_did: r.author_did,
        author_name: r.author_name,
        author_avatar: r.author_avatar,
      });
    }
  }

  // ── Step 3: batch-fetch reactions / tags / embeds keyed by id ─────────
  const idPh = ids.map(() => "?").join(",");

  const reactionRows = db
    .query<
      { entity: string; reaction: string; user: string; reaction_id: string },
      string[]
    >(
      `select entity, reaction, user, reaction_id from comp_reaction
        where entity in (${idPh})`,
    )
    .all(...ids);

  const tagRows = db
    .query<{ head: string; tail: string }, string[]>(
      `select head, tail from edges
        where head in (${idPh}) and label = 'tag'`,
    )
    .all(...ids);

  const embedRows = db
    .query<
      {
        message_id: string;
        url: string;
        mime_type: string;
        alt: string | null;
      },
      string[]
    >(
      // entities.room = messageId for embed entities; UNION across the four
      // embed component tables. comp_embed_link has no mime_type/alt — fall
      // back to "text/uri-list".
      `select e.room as message_id, ei.entity as url,
              ei.mime_type as mime_type, ei.alt as alt
         from comp_embed_image ei
         join entities e on e.id = ei.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ev.entity as url,
              ev.mime_type as mime_type, ev.alt as alt
         from comp_embed_video ev
         join entities e on e.id = ev.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ef.entity as url,
              ef.mime_type as mime_type, null as alt
         from comp_embed_file ef
         join entities e on e.id = ef.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, el.entity as url,
              'text/uri-list' as mime_type, null as alt
         from comp_embed_link el
         join entities e on e.id = el.entity
        where e.room in (${idPh})`,
    )
    // Each UNION branch has its own `where ... in (${idPh})` — bind ids
    // once per branch (4× total). bun:sqlite has no positional reuse here.
    .all(...ids, ...ids, ...ids, ...ids);

  // ── Step 4: assemble ──────────────────────────────────────────────────
  const reactionMap = new Map<string, Map<string, Set<string>>>();
  // Viewer's reaction_id per (message, emoji) for myReactionId.
  const viewerReactionId = new Map<string, Map<string, string>>();
  for (const r of reactionRows) {
    let perMsg = reactionMap.get(r.entity);
    if (!perMsg) {
      perMsg = new Map();
      reactionMap.set(r.entity, perMsg);
    }
    let dids = perMsg.get(r.reaction);
    if (!dids) {
      dids = new Set();
      perMsg.set(r.reaction, dids);
    }
    dids.add(r.user);

    // Track the viewer's reaction_id for this (entity, emoji) pair.
    if (viewerDid && r.user === viewerDid) {
      let perMsgViewer = viewerReactionId.get(r.entity);
      if (!perMsgViewer) {
        perMsgViewer = new Map();
        viewerReactionId.set(r.entity, perMsgViewer);
      }
      perMsgViewer.set(r.reaction, r.reaction_id);
    }
  }

  const tagMap = new Map<string, string[]>();
  for (const t of tagRows) {
    let arr = tagMap.get(t.head);
    if (!arr) {
      arr = [];
      tagMap.set(t.head, arr);
    }
    arr.push(t.tail);
  }

  const mediaMap = new Map<
    string,
    Array<{ url: string; type: string; alt: string | null }>
  >();
  for (const e of embedRows) {
    let arr = mediaMap.get(e.message_id);
    if (!arr) {
      arr = [];
      mediaMap.set(e.message_id, arr);
    }
    arr.push({ url: e.url, type: e.mime_type, alt: e.alt });
  }

  const messages: MessageDto[] = baseRows.map((r) => {
    // If this row is a forward reference (no own content, has forward_target),
    // substitute the original's content/author.
    let mime = r.mime_type;
    let data = r.data;
    let ts = r.timestamp;
    let authorDid = r.author_did;
    let authorName = r.author_name;
    let authorAvatar = r.author_avatar;

    if (r.data === null && r.forward_target) {
      const orig = forwardOrig.get(r.forward_target);
      if (orig) {
        mime = orig.mime_type;
        data = orig.data;
        ts = orig.timestamp;
        authorDid = orig.author_did;
        authorName = orig.author_name;
        authorAvatar = orig.author_avatar;
      }
    }

    const content = decodeContent(mime, data);

    const reactions: Array<ReactionDto> = [];
    const perMsg = reactionMap.get(r.id);
    const perMsgViewer = viewerReactionId.get(r.id);
    if (perMsg) {
      for (const [emoji, dids] of perMsg.entries()) {
        reactions.push(stripNulls({
          emoji,
          dids: [...dids].sort(),
          myReactionId: perMsgViewer?.get(emoji) ?? null,
        }) as ReactionDto);
      }
    }

    const mediaForMsg = (mediaMap.get(r.id) ?? []).map((m) => stripNulls(m) as { url: string; type: string; alt?: string });

    return stripNulls({
      id: r.id,
      sort_idx: r.sort_idx,
      content,
      authorDid: authorDid ?? "",
      authorName: authorName ?? "",
      authorAvatar: authorAvatar,
      timestamp: ts != null ? new Date(ts).toISOString() : "",
      replyTo: r.reply_to,
      forwardedFrom:
        r.forward_target != null
          ? {
              name: r.forward_target_room_name ?? "",
              roomId: r.forward_target_room ?? "",
            }
          : null,
      reactions,
      media: mediaForMsg,
      tags: tagMap.get(r.id) ?? [],
    }) as MessageDto;
  });

  // Sort ascending so callers get oldest → newest (matches spec example).
  // sort_idx is set by the materializer for messages (using the canonical
  // timestamp from the ULID or timestampOverride extension). Fall back to
  // entity id (ULID-encoded timestamp) for entities without sort_idx.
  messages.sort((a, b) =>
    (a.sort_idx ?? a.id).localeCompare(b.sort_idx ?? b.id),
  );

  // Pagination cursor: only meaningful for room scope.
  let nextCursor: string | null = null;
  if (scope.kind === "room") {
    const limit = Math.max(1, Math.min(scope.limit, 100));
    if (baseRows.length === limit) {
      // Cursor is the smallest id in the page (= first item after sort asc).
      nextCursor = messages[0]?.id ?? null;
    }
  }

  return { messages, nextCursor };
}

function decodeContent(
  mime: string | null,
  data: Buffer | Uint8Array | null,
): string {
  if (data === null) return "";
  // The content blob is opaque from the appserver's perspective — for
  // text/* we decode utf-8; for everything else we return base64 so the
  // wire format stays JSON-safe. Real callers care about text/markdown.
  const buf = data instanceof Buffer ? data : Buffer.from(data);
  if (!mime || mime.startsWith("text/") || mime === "application/json") {
    return buf.toString("utf8");
  }
  return buf.toString("base64");
}
