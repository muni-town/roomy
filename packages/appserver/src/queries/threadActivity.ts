/**
 * Thread activity helper.
 *
 * Used by `space.getThreads`, `room.getThreads`, and the `recentThreads` field
 * of `room.getMetadata`. Returns each thread with its latest message timestamp
 * and up to 3 unique recent participants.
 *
 * Forwarded messages are forward-reference entities with no own content/author
 * — their timestamp and author live on the original message reached via the
 * `forward` edge. We follow that edge (coalescing the message's own content
 * with the forwarded original's) so a thread created by forwarding messages
 * still reports a latest timestamp, recent participants (the original authors),
 * and a latest message — matching what `selectMessages` displays.
 *
 * Implementation note: the equivalent frontend LiveQuery used a window function
 * with `partition by author` over a SELECT alias and silently returned 0–1
 * members because window functions evaluate before aliases (memory:
 * 2026-01-30). We sidestep that here by using a per-thread aggregate with
 * `json_group_array(distinct ...)` over the top-N most recent messages.
 */

import type { Database } from "bun:sqlite";
import { decodeContent } from "../db/content.ts";

export interface ThreadMember {
  did: string;
  name: string | null;
  avatar: string | null;
}

export interface ThreadMessage {
  id: string;
  content: string;
  author: ThreadMember;
  timestamp: string | null;
}

export interface ThreadActivity {
  id: string;
  name: string | null;
  /** Canonical parent channel ID (head of the canonical 'link' edge), null if none. */
  canonicalParent: string | null;
  /** Latest message timestamp in this thread (ISO string), null if no messages. */
  latestTimestamp: string | null;
  latestMembers: ThreadMember[];
  /** The most recent message in this thread, null if no messages. */
  latestMessage: ThreadMessage | null;
}

export type ThreadScope =
  | { kind: "space"; spaceId: string }
  | { kind: "channel"; channelId: string };

/**
 * Threads visible in this scope, with activity metadata.
 *
 * Scope semantics:
 *   - `space`: all threads (entities with comp_room.label='space.roomy.thread'
 *     and stream_id = spaceId).
 *   - `channel`: threads canonically linked from this channel.
 *
 * The caller is responsible for filtering by read access — this helper does
 * not check permissions.
 */
export function listThreadActivity(
  db: Database,
  scope: ThreadScope,
  limit = 50,
): ThreadActivity[] {
  // Step 1: select the candidate threads in scope.
  const threads =
    scope.kind === "space"
      ? db
          .query<{ id: string; name: string | null }, [string]>(
            `select e.id as id, ci.name as name
               from entities e
               join comp_room cr on cr.entity = e.id
               left join comp_info ci on ci.entity = e.id
              where e.stream_id = ?
                and cr.label = 'space.roomy.thread'
                and coalesce(cr.deleted, 0) = 0`,
          )
          .all(scope.spaceId)
      : db
          .query<{ id: string; name: string | null }, [string]>(
            `select e.id as id, ci.name as name
               from entities e
               join comp_room cr on cr.entity = e.id
               left join comp_info ci on ci.entity = e.id
               join edges link_e on link_e.tail = e.id
                 and link_e.label = 'link'
                 and coalesce(json_extract(link_e.payload, '$.canonical_parent'), 0) = 1
              where cr.label = 'space.roomy.thread'
                and coalesce(cr.deleted, 0) = 0
                and link_e.head = ?`,
          )
          .all(scope.channelId);

  if (threads.length === 0) return [];

  const threadIds = threads.map((t) => t.id);
  const ph = threadIds.map(() => "?").join(",");

  // Step 2: batch-fetch latest timestamps for all threads at once.
  //
  // Forwarded messages are forward-reference entities with no comp_content of
  // their own — their content/timestamp lives on the original message reached
  // via the `forward` edge. We follow that edge so a thread created by
  // forwarding messages still surfaces a latest timestamp (the original's).
  const latestRows = db
    .query<{ room: string; ts: number | null }, string[]>(
      `select e.room as room,
              max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges forward_e
           on forward_e.head = e.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
        where e.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
        group by e.room`,
    )
    .all(...threadIds);
  const latestMap = new Map(latestRows.map((r) => [r.room, r.ts]));

  // Step 3: batch-fetch recent participants (up to 3 per thread).
  // We fetch all and group in JS.
  //
  // For forwarded messages the author edge lives on the original (reached via
  // the `forward` edge), so we coalesce the message's own author with the
  // forwarded original's author. The original's author then counts as a
  // recent participant of the thread it was forwarded into.
  const participantRows = db
    .query<
      { room: string; did: string; name: string | null; avatar: string | null; ts: number | null },
      string[]
    >(
      `select msg.room as room,
              coalesce(author_e.tail, fwd_author_e.tail) as did,
              ci.name as name,
              ci.avatar as avatar,
              max(coalesce(cc.timestamp, fwd_cc.timestamp)) as ts
         from entities msg
         left join comp_content cc on cc.entity = msg.id
         left join edges author_e
           on author_e.head = msg.id and author_e.label = 'author'
         left join edges forward_e
           on forward_e.head = msg.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
         left join edges fwd_author_e
           on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
         left join comp_info ci
           on ci.entity = coalesce(author_e.tail, fwd_author_e.tail)
        where msg.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)
          and coalesce(author_e.tail, fwd_author_e.tail) is not null
        group by msg.room, coalesce(author_e.tail, fwd_author_e.tail)
        order by msg.room, ts desc`,
    )
    .all(...threadIds);

  // Group participants by room, take top 3 per room.
  const participantsMap = new Map<string, ThreadMember[]>();
  for (const r of participantRows) {
    let arr = participantsMap.get(r.room);
    if (!arr) {
      arr = [];
      participantsMap.set(r.room, arr);
    }
    if (arr.length < 3) {
      arr.push({ did: r.did, name: r.name, avatar: r.avatar });
    }
  }

  // Step 4: batch-fetch canonical parent for all threads.
  const parentRows = db
    .query<{ tail: string; head: string }, string[]>(
      `select tail, head from edges
        where tail in (${ph})
          and label = 'link'
          and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1`,
    )
    .all(...threadIds);
  const parentMap = new Map(parentRows.map((r) => [r.tail, r.head]));

  // Step 5: batch-fetch latest message for all threads.
  // SQLite doesn't support LIMIT per group, so we fetch all messages
  // and pick the latest per thread in JS.
  //
  // Forwarded messages have no own content/author — follow the `forward` edge
  // to the original and coalesce so a thread created solely by forwarding
  // still reports a latest message (the original's content/author/timestamp).
  const latestMsgRows = db
    .query<
      {
        room: string;
        id: string;
        mime_type: string | null;
        data: Buffer | Uint8Array | null;
        author_did: string | null;
        author_name: string | null;
        author_avatar: string | null;
        timestamp: number | null;
      },
      string[]
    >(
      `select e.room as room,
              e.id as id,
              coalesce(cc.mime_type, fwd_cc.mime_type) as mime_type,
              coalesce(cc.data, fwd_cc.data) as data,
              coalesce(author_e.tail, fwd_author_e.tail) as author_did,
              author_info.name as author_name,
              author_info.avatar as author_avatar,
              coalesce(cc.timestamp, fwd_cc.timestamp) as timestamp
         from entities e
         left join comp_content cc on cc.entity = e.id
         left join edges author_e
           on author_e.head = e.id and author_e.label = 'author'
         left join edges forward_e
           on forward_e.head = e.id and forward_e.label = 'forward'
         left join comp_content fwd_cc on fwd_cc.entity = forward_e.tail
         left join edges fwd_author_e
           on fwd_author_e.head = forward_e.tail and fwd_author_e.label = 'author'
         left join comp_info author_info
           on author_info.entity = coalesce(author_e.tail, fwd_author_e.tail)
        where e.room in (${ph})
          and (cc.entity is not null or forward_e.tail is not null)`,
    )
    .all(...threadIds);

  // Pick the latest message per thread (highest timestamp).
  const latestMsgMap = new Map<
    string,
    {
      id: string;
      mime_type: string | null;
      data: Buffer | Uint8Array | null;
      author_did: string | null;
      author_name: string | null;
      author_avatar: string | null;
      timestamp: number | null;
    }
  >();
  for (const r of latestMsgRows) {
    const existing = latestMsgMap.get(r.room);
    if (!existing || (r.timestamp ?? 0) > (existing.timestamp ?? 0)) {
      latestMsgMap.set(r.room, r);
    }
  }

  const results: ThreadActivity[] = threads.map((t) => {
    const latest = latestMap.get(t.id);
    const members = participantsMap.get(t.id) ?? [];
    const parent = parentMap.get(t.id);
    const latestMsgRow = latestMsgMap.get(t.id);

    let latestMessage: ThreadMessage | null = null;
    if (latestMsgRow && latestMsgRow.author_did) {
      latestMessage = {
        id: latestMsgRow.id,
        content: decodeContent(latestMsgRow.mime_type, latestMsgRow.data),
        author: {
          did: latestMsgRow.author_did,
          name: latestMsgRow.author_name,
          avatar: latestMsgRow.author_avatar,
        },
        timestamp:
          latestMsgRow.timestamp != null
            ? new Date(latestMsgRow.timestamp).toISOString()
            : null,
      };
    }

    return {
      id: t.id,
      name: t.name,
      canonicalParent: parent ?? null,
      latestTimestamp:
        latest != null ? new Date(latest).toISOString() : null,
      latestMembers: members,
      latestMessage,
    };
  });

  // Sort: most-recently-active first, then alphabetic by name as a tiebreaker.
  results.sort((a, b) => {
    if (a.latestTimestamp === b.latestTimestamp) {
      return (a.name ?? "").localeCompare(b.name ?? "");
    }
    if (a.latestTimestamp === null) return 1;
    if (b.latestTimestamp === null) return -1;
    return b.latestTimestamp.localeCompare(a.latestTimestamp);
  });

  return results.slice(0, limit);
}
