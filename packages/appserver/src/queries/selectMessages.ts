/**
 * Message selection helper used by `room.getMessages` and `message.getMessage`.
 *
 * Returns fully denormalised message objects with all joins resolved
 * server-side: author, content, replyTo, forwardedFrom, reactions, media,
 * linkEmbeds.
 *
 * A forwarded message is the forwarder's own message; the original is fully
 * denormalised (author, content, timestamp, reactions, media, link embeds,
 * and its own `forwardedFrom` chain for nested forwards) and nested under
 * `forwardedFrom.message` so clients render forwards with no extra fetches.
 *
 * Strategy: 1 query for the message rows + singleton-edge joins (author,
 * reply, forward), then 3 small batch queries (reactions, image+video+
 * file+link embeds, link embed data) keyed on the page's IDs, plus one
 * recursive `selectMessages` batch for the forwarded originals. Constant
 * query count, regardless of page size.
 *
 * The caller is responsible for authorisation — this helper does not check
 * read access.
 */

import type { DbLike } from "../db/types.ts";
import { decodeContent } from "../db/content.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import { hydrateProfiles, resolveProfiles } from "./profileStore.ts";
import { decodeTime } from "ulidx";

export interface ReactionDto {
  emoji: string;
  count: number;
  /** reaction_id of the viewer's own reaction for this emoji; absent when not reacted. */
  myReactionId?: string;
}

export interface LinkEmbedDto {
  url: string;
  /** Enriched embed data (EmbedV1 JSON), absent when enrichment hasn't completed or had no data. */
  embed?: Record<string, unknown>;
}

export interface MediaDto {
  url: string;
  type: string;
  alt?: string;
  width?: number;
  height?: number;
  blurhash?: string;
  size?: number;
  length?: number;
  name?: string;
}

export interface MessageDto {
  id: string;
  /** Sort index for timeline ordering. ULID based on canonical timestamp. */
  sort_idx?: string;
  content: string;
  /**
   * MIME type of the content blob. `text/markdown` for legacy messages,
   * `application/vnd.roomy.richtext+json` for blocks+facets messages.
   * Clients branch rendering on this.
   */
  mimeType?: string;
  authorDid: string;
  authorName: string;
  authorHandle?: string;
  authorAvatar?: string;
  /**
   * True for system messages — messages authored by the space itself (e.g.
   * "X joined the space", "X created [thread]"). The author line is not
   * meaningful for these; clients hide the author identity and rely on the
   * message body.
   */
  system?: boolean;
  timestamp: string;
  replyTo?: string;
  forwardedFrom?: {
    messageId: string;
    name: string;
    roomId: string;
    /** Fully denormalised original message (its own forwardedFrom chain
     *  included for nested forwards). Absent when the original couldn't be
     *  resolved (deleted, not-yet-materialised, or cross-space). */
    message?: MessageDto;
  };
  reactions: Array<ReactionDto>;
  media: Array<MediaDto>;
  /** Link embeds with enriched metadata from the embed service. */
  linkEmbeds: Array<LinkEmbedDto>;
}

export type SelectScope =
  | { kind: "room"; roomId: string; limit: number; cursor: string | null }
  | {
      kind: "ids";
      ids: string[];
      /**
       * Internal: ids already on the current forward-resolution chain. A
       * forward never re-resolves an id already seen, bounding pathological
       * cycles (A forwards B, B forwards A) to one pass instead of
       * recursing forever.
       */
      forwardChain?: string[];
    };

interface BaseRow {
  id: string;
  stream_id: string | null;
  sort_idx: string | null;
  room: string | null;
  mime_type: string | null;
  data: Buffer | Uint8Array | null;
  timestamp: number | null;
  author_did: string | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar: string | null;
  reply_to: string | null;
  forward_target: string | null;
  forward_target_room: string | null;
  forward_target_room_name: string | null;
}

export async function selectMessages(
  db: DbLike,
  scope: SelectScope,
  viewerDid?: string,
): Promise<{ messages: MessageDto[]; nextCursor: string | null }> {
  // ── Step 1: pull the base rows ────────────────────────────────────────
  let baseRows: BaseRow[];
  if (scope.kind === "room") {
    const sql = `
      select
        e.id as id,
        e.stream_id as stream_id,
        e.sort_idx as sort_idx,
        e.room as room,
        cc.mime_type as mime_type,
        cc.data as data,
        cc.timestamp as timestamp,
        author_e.tail as author_did,
        author_info.name as author_name,
        author_info.avatar as author_avatar,
        author_user.handle as author_handle,
        reply_e.tail as reply_to,
        forward_e.tail as forward_target,
        forward_target_entity.room as forward_target_room,
        forward_target_room_info.name as forward_target_room_name
      from entities e
      left join comp_content cc on cc.entity = e.id
      left join edges author_e
        on author_e.head = e.id and author_e.label = 'author'
      left join comp_info author_info on author_info.entity = author_e.tail
      left join comp_user author_user on author_user.did = author_e.tail
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
      -- Order by sort_idx directly (not coalesce(sort_idx, id)) so SQLite can
      -- use idx_entities_room_sort and stop after the limit. Messages always
      -- have sort_idx set by the materializer, so the coalesce fallback to id
      -- was never exercised for the rows this filter keeps; the coalesce forced
      -- a full temp-B-tree sort of every entity in the room, which is
      -- catastrophic on a large bridged channel.
      order by e.sort_idx desc
      limit ${Math.max(1, Math.min(scope.limit, 100))}
    `;
    const stmt = db.query(sql);
    baseRows = scope.cursor
      ? await stmt.all([scope.roomId, scope.cursor])
      : await stmt.all([scope.roomId]);
  } else {
    if (scope.ids.length === 0) {
      return { messages: [], nextCursor: null };
    }
    const placeholders = scope.ids.map(() => "?").join(",");
    baseRows = await db
      .query(
        `
        select
          e.id as id,
          e.stream_id as stream_id,
          e.sort_idx as sort_idx,
          e.room as room,
          cc.mime_type as mime_type,
          cc.data as data,
          cc.timestamp as timestamp,
          author_e.tail as author_did,
          author_info.name as author_name,
          author_info.avatar as author_avatar,
          author_user.handle as author_handle,
          reply_e.tail as reply_to,
          forward_e.tail as forward_target,
          forward_target_entity.room as forward_target_room,
          forward_target_room_info.name as forward_target_room_name
        from entities e
        left join comp_content cc on cc.entity = e.id
        left join edges author_e
          on author_e.head = e.id and author_e.label = 'author'
        left join comp_info author_info on author_info.entity = author_e.tail
        left join comp_user author_user on author_user.did = author_e.tail
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
      .all([...scope.ids]);
  }

  if (baseRows.length === 0) return { messages: [], nextCursor: null };

  const ids = baseRows.map((r) => r.id);

  // ── Step 2: forwarded-original resolution ─────────────────────────────
  // Every forward row (forward-as-embed with own content, or a legacy
  // forward reference with no own content) carries a `forwardedFrom`. The
  // original is fetched as a fully denormalised MessageDto (via
  // selectMessages, so its own forwardedFrom chain, reactions, media and
  // link embeds are all resolved) and embedded in `forwardedFrom.message`.
  // Clients render the embedded original directly — no extra fetches.
  //
  // Previously this step substituted the original's content and author into
  // the forward row, which made a forward look like the ORIGINAL's message
  // and (with the forwarder's own content present) rendered the same content
  // twice. That substitution is gone: a forward is always the forwarder's
  // message, with the original nested under `forwardedFrom.message`.
  //
  // Constant query count: one `selectMessages` batch call per chain level.
  // The chain set bounds pathological cycles (A forwards B, B forwards A):
  // a forward never re-resolves an id already on its chain.
  const chain = new Set(scope.kind === "ids" ? (scope.forwardChain ?? []) : []);
  const forwardTargets = baseRows
    .filter((r) => r.forward_target && !chain.has(r.forward_target))
    .map((r) => r.forward_target!) as string[];

  const forwardOriginalDto = new Map<string, MessageDto>();
  if (forwardTargets.length > 0) {
    const { messages: originals } = await selectMessages(
      db,
      { kind: "ids", ids: [...new Set(forwardTargets)], forwardChain: [...chain, ...forwardTargets] },
      viewerDid,
    );
    for (const orig of originals) forwardOriginalDto.set(orig.id, orig);
  }

  // ── Step 3: batch-fetch reactions / embeds / link embed data keyed by id ──
  const idPh = ids.map(() => "?").join(",");

  const reactionRows = await db
    .query(
      `select entity, reaction, user, reaction_id from comp_reaction
        where entity in (${idPh})`,
    )
    .all<{ entity: string; reaction: string; user: string; reaction_id: string }>([...ids]);

  const embedRows = await db
    .query(
      // entities.room = messageId for embed entities; UNION across the four
      // embed component tables. comp_embed_link has no media metadata — fall
      // back to nulls and "text/uri-list" mime type. Image/video share
      // width/height/blurhash/size; video adds length; file adds name.
      `select e.room as message_id, ei.entity as url,
              ei.mime_type as mime_type, ei.alt as alt,
              ei.width as width, ei.height as height,
              ei.blurhash as blurhash, ei.size as size,
              null as length, null as name
         from comp_embed_image ei
         join entities e on e.id = ei.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ev.entity as url,
              ev.mime_type as mime_type, ev.alt as alt,
              ev.width as width, ev.height as height,
              ev.blurhash as blurhash, ev.size as size,
              ev.length as length, null as name
         from comp_embed_video ev
         join entities e on e.id = ev.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, ef.entity as url,
              ef.mime_type as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, ef.size as size,
              null as length, ef.name as name
         from comp_embed_file ef
         join entities e on e.id = ef.entity
        where e.room in (${idPh})
       union all
       select e.room as message_id, el.entity as url,
              'text/uri-list' as mime_type, null as alt,
              null as width, null as height,
              null as blurhash, null as size,
              null as length, null as name
         from comp_embed_link el
         join entities e on e.id = el.entity
        where e.room in (${idPh})
          and el.show_preview = 1`,
    )
    // Each UNION branch has its own `where ... in (${idPh})` — bind ids
    // once per branch (4× total). bun:sqlite has no positional reuse here.
    .all<{
      message_id: string;
      url: string;
      mime_type: string;
      alt: string | null;
      width: number | null;
      height: number | null;
      blurhash: string | null;
      size: number | null;
      length: number | null;
      name: string | null;
    }>([...ids, ...ids, ...ids, ...ids]);

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

  const mediaMap = new Map<
    string,
    Array<MediaDto>
  >();
  for (const e of embedRows) {
    let arr = mediaMap.get(e.message_id);
    if (!arr) {
      arr = [];
      mediaMap.set(e.message_id, arr);
    }
    arr.push(stripNulls({
      url: e.url,
      type: e.mime_type,
      alt: e.alt ?? undefined,
      width: e.width ?? undefined,
      height: e.height ?? undefined,
      blurhash: e.blurhash ?? undefined,
      size: e.size ?? undefined,
      length: e.length ?? undefined,
      name: e.name ?? undefined,
    }) as MediaDto);
  }

  // ── Step 3b: batch-fetch enriched link embed data ────────────────────
  // Fetch cached embed data for all link URLs found in this page.
  // We need to collect the link URLs first, then query comp_embed_link_data.
  const linkUrls = new Set<string>();
  for (const e of embedRows) {
    if (e.mime_type === "text/uri-list") {
      linkUrls.add(e.url);
    }
  }

  const linkEmbedDataMap = new Map<string, Record<string, unknown> | null>();
  if (linkUrls.size > 0) {
    const urlList = [...linkUrls];
    const ph = urlList.map(() => "?").join(",");
    const linkDataRows = await db
      .query(
        `select entity, embed_json from comp_embed_link_data
          where entity in (${ph})`,
      )
      .all<{ entity: string; embed_json: string | null }>([...urlList]);
    for (const row of linkDataRows) {
      linkEmbedDataMap.set(
        row.entity,
        row.embed_json ? (JSON.parse(row.embed_json) as Record<string, unknown>) : null,
      );
    }
  }

  // Build linkEmbeds map: messageId → LinkEmbedDto[]
  const linkEmbedsMap = new Map<string, Array<LinkEmbedDto>>();
  for (const e of embedRows) {
    if (e.mime_type === "text/uri-list") {
      let arr = linkEmbedsMap.get(e.message_id);
      if (!arr) {
        arr = [];
        linkEmbedsMap.set(e.message_id, arr);
      }
      const embedData = linkEmbedDataMap.get(e.url);
      arr.push({
        url: e.url,
        ...(embedData != null ? { embed: embedData } : {}),
      });
    }
  }

  const messages: MessageDto[] = baseRows.map((r) => {
    // A forward row keeps its OWN content and author — it is the forwarder's
    // message. The original is nested under `forwardedFrom.message` (see
    // Step 2) for clients to render; it is never substituted into the row.
    const mime = r.mime_type;
    const data = r.data;
    const ts = r.timestamp;
    const authorDid = r.author_did;
    const authorName = r.author_name;
    const authorHandle = r.author_handle;
    const authorAvatar = r.author_avatar;

    const content = decodeContent(mime, data);

    const reactions: Array<ReactionDto> = [];
    const perMsg = reactionMap.get(r.id);
    const perMsgViewer = viewerReactionId.get(r.id);
    if (perMsg) {
      for (const [emoji, dids] of perMsg.entries()) {
        reactions.push(stripNulls({
          emoji,
          count: dids.size,
          myReactionId: perMsgViewer?.get(emoji) ?? null,
        }) as ReactionDto);
      }
    }

    const mediaForMsg = mediaMap.get(r.id) ?? [];
    const linkEmbedsForMsg = linkEmbedsMap.get(r.id) ?? [];

    return stripNulls({
      id: r.id,
      sort_idx: r.sort_idx,
      content,
      mimeType: mime ?? undefined,
      authorDid: authorDid ?? "",
      authorName: authorName ?? "",
      authorHandle: authorHandle,
      authorAvatar: authorAvatar,
      system:
        authorDid != null && r.stream_id != null && authorDid === r.stream_id
          ? true
          : undefined,
      // Legacy forward-reference rows (forwardMessages.v0) carry no
      // comp_content, so cc.timestamp is NULL. Fall back to the forward
      // event's own ULID time — the entity id IS the forward event's ULID —
      // so the forwarder's timestamp is real (the client renders it in the
      // forward context line and sorts diffs by it; an empty string rendered
      // as "Invalid Date" and NaN-sorted to the end of the cache).
      timestamp:
        ts != null
          ? new Date(ts).toISOString()
          : r.forward_target != null
            ? new Date(decodeTime(r.id)).toISOString()
            : "",
      replyTo: r.reply_to,
      forwardedFrom:
        r.forward_target != null
          ? stripNulls({
              messageId: r.forward_target,
              name: r.forward_target_room_name ?? "",
              roomId: r.forward_target_room ?? "",
              message: forwardOriginalDto.get(r.forward_target) ?? null,
            })
          : null,
      reactions,
      media: mediaForMsg,
      linkEmbeds: linkEmbedsForMsg,
    }) as MessageDto;
  });

  // Resolve author profiles from the global store (with an in-memory cache).
  // A message author's profile entity lives in their own stream, not this
  // space's stream, so the per-space comp_user/comp_info join above is null
  // for cross-stream authors. The global `profiles` table is authoritative;
  // the per-space value (if any) acts as a fallback.
  await hydrateProfiles(
    messages,
    (m) => m.authorDid,
    (m, p) => {
      if (p.name != null) m.authorName = p.name;
      if (p.handle != null) m.authorHandle = p.handle;
      if (p.avatar != null) m.authorAvatar = p.avatar;
    },
  );

  // System messages are authored by the space and reference a *different*
  // user (the joiner / thread creator) in their body by DID — the SDK
  // materialiser stores the raw DID as the link label deterministically.
  // Resolve those DIDs to the user's current handle/display name here, at
  // read time, so the UI never shows a bare DID and we don't bake a missing
  // or stale handle into the stored message.
  await resolveSystemMessageNames(messages);

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

/**
 * Resolve display names for users referenced by system messages.
 *
 * A system message is authored by the space and references a *different*
 * user (the joiner / thread creator) in its markdown body as
 * `[@<did>](/user/<did>)`. The materialiser stores the raw DID as the link
 * label deterministically, so resolve it to the user's current display
 * name / handle from the global profile store and rewrite the link label —
 * the UI never shows a bare DID. DIDs we can't resolve are left untouched
 * (the user has no profile anywhere); the label remains a clickable link.
 */
async function resolveSystemMessageNames(messages: MessageDto[]): Promise<void> {
  const systemMessages = messages.filter((m) => m.system);
  if (systemMessages.length === 0) return;

  // Collect every `/user/<did>` reference so we can batch-resolve profiles.
  const userLinkRe = /\[\@[^\]]+\]\(\/user\/([^)]+)\)/g;
  const dids = new Set<string>();
  for (const m of systemMessages) {
    for (const match of m.content.matchAll(userLinkRe)) {
      const raw = match[1];
      if (raw) dids.add(decodeURIComponent(raw));
    }
  }
  if (dids.size === 0) return;

  const profiles = await resolveProfiles([...dids]);
  const labelRe = /\[\@([^\]]+)\]\(\/user\/([^)]+)\)/g;
  for (const m of systemMessages) {
    if (!m.content.includes("/user/")) continue;
    m.content = m.content.replace(
      labelRe,
      (whole: string, label: string, didPath: string) => {
        const did = decodeURIComponent(didPath);
        const p = profiles.get(did);
        // Only rewrite the deterministic DID label (label === DID path); leave
        // any pre-existing baked handle or user-authored content untouched.
        if (!p || label !== didPath) return whole;
        // Treat empty/whitespace names as absent: the Bluesky appview returns
        // displayName:"" for users without one, and "" would win over the
        // handle (and then fail the !rendered guard, bailing to the raw DID).
        const name = p.name?.trim() ? p.name : null;
        const rendered = name ?? (p.handle ? `@${p.handle}` : null);
        if (!rendered) return whole;
        return `[${rendered}]${whole.slice(whole.indexOf("("))}`;
      },
    );
  }
}
