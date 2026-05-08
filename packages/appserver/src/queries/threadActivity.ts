/**
 * Thread activity helper.
 *
 * Used by `space.getThreads`, `room.getThreads`, and the `recentThreads` field
 * of `room.getMetadata`. Returns each thread with its latest message timestamp
 * and up to 3 unique recent participants.
 *
 * Implementation note: the equivalent frontend LiveQuery used a window function
 * with `partition by author` over a SELECT alias and silently returned 0–1
 * members because window functions evaluate before aliases (memory:
 * 2026-01-30). We sidestep that here by using a per-thread aggregate with
 * `json_group_array(distinct ...)` over the top-N most recent messages.
 */

import type { Database } from "bun:sqlite";

export interface ThreadMember {
  did: string;
  name: string | null;
  avatar: string | null;
}

export interface ThreadActivity {
  id: string;
  name: string | null;
  /** Canonical parent channel ID (head of the canonical 'link' edge), null if none. */
  canonicalParent: string | null;
  /** Latest message timestamp in this thread (ISO string), null if no messages. */
  latestTimestamp: string | null;
  latestMembers: ThreadMember[];
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
          .query<
            { id: string; name: string | null },
            [string]
          >(
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
          .query<
            { id: string; name: string | null },
            [string]
          >(
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

  // Step 2: for each thread, fetch latest timestamp + up to 3 recent participants.
  // Doing this per-thread keeps the SQL legible and avoids the partition-by-alias
  // pitfall noted above. Most rooms have few threads; if hot, batch this later.
  const latestStmt = db.query<
    { ts: number | null },
    [string]
  >(
    `select max(cc.timestamp) as ts
       from entities e
       join comp_content cc on cc.entity = e.id
      where e.room = ?`,
  );

  const recentParticipantsStmt = db.query<
    {
      did: string;
      name: string | null;
      avatar: string | null;
    },
    [string]
  >(
    // Latest distinct authors. We pick the most recent N=3 by joining
    // comp_content for timestamp; window function via group_concat is
    // overkill — a small correlated subquery + DISTINCT is fine.
    `select did, name, avatar from (
       select author_e.tail as did,
              ci.name as name,
              ci.avatar as avatar,
              max(cc.timestamp) as ts
         from entities msg
         join comp_content cc on cc.entity = msg.id
         join edges author_e on author_e.head = msg.id and author_e.label = 'author'
         left join comp_info ci on ci.entity = author_e.tail
        where msg.room = ?
        group by author_e.tail
     )
     order by ts desc
     limit 3`,
  );

  const parentStmt = db.query<
    { head: string },
    [string]
  >(
    `select head from edges
      where tail = ? and label = 'link'
        and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
      limit 1`,
  );

  const results: ThreadActivity[] = threads.map((t) => {
    const latest = latestStmt.get(t.id);
    const members = recentParticipantsStmt.all(t.id);
    const parent = parentStmt.get(t.id);

    return {
      id: t.id,
      name: t.name,
      canonicalParent: parent?.head ?? null,
      latestTimestamp:
        latest?.ts != null ? new Date(latest.ts).toISOString() : null,
      latestMembers: members.map((m) => ({
        did: m.did,
        name: m.name,
        avatar: m.avatar,
      })),
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
