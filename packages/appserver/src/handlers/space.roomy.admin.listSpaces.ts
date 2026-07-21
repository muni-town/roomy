/**
 * XRPC: space.roomy.admin.listSpaces (query).
 *
 * Paginated, per-space stats for the admin dashboard. Each row carries
 * member/event counters and an event-type breakdown for one space, sorted
 * by member count descending (ties broken by space DID ascending so the
 * order is stable across pages).
 *
 * The cursor is `"<memberCount>|<did>"` of the last row on the current
 * page; the next page starts strictly after that (member count, did)
 * under the same sort. Capped at 100 rows per page.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { optionalInt, optionalString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export interface AdminSpaceStats {
  did: string;
  name: string;
  memberCount: number;
  totalEvents: number;
  eventsToday: number;
  eventBreakdown: Record<string, number>;
}

export interface ListSpacesResult {
  spaces: AdminSpaceStats[];
  cursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Parse the opaque cursor into `{ memberCount, did }`. Returns null when
 * the cursor is absent or malformed (the handler treats null as "first
 * page" rather than erroring, so a stale client cursor degrades to a
 * fresh first page instead of a 400).
 *
 * The cursor is `"<memberCount>|<did>"`; `|` is chosen because it never
 * appears in a DID (`did:plc:` / `did:web:` use only colons).
 */
function parseCursor(cursor: string): { memberCount: number; did: string } | null {
  const sep = cursor.indexOf("|");
  if (sep <= 0 || sep === cursor.length - 1) return null;
  const count = Number(cursor.slice(0, sep));
  const did = cursor.slice(sep + 1);
  if (!Number.isInteger(count) || count < 0 || did.length === 0) return null;
  return { memberCount: count, did };
}

export const adminListSpacesHandler: QueryHandler<
  QueryParams,
  ListSpacesResult
> = async (params: QueryParams, auth: AuthCtx) => {
  requireAdmin(auth);

  const limit = optionalInt(params, "limit", {
    min: 1,
    max: MAX_LIMIT,
    default: DEFAULT_LIMIT,
  });
  const cursorRaw = optionalString(params, "cursor") ?? null;
  const cursor = cursorRaw ? parseCursor(cursorRaw) : null;

  const db = openDb();
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const todayStart = todayMidnight.getTime();

  // ── Per-space aggregates, sorted by member count desc, did asc ──────────
  //
  // The events DB is ATTACHed as `events`, so its `stream_events` table is
  // queryable from the main handle. Event counters are correlated
  // subqueries against the events DB; member count is a left-joined count
  // over `edges` (head = space, label in ('member','admin')).
  //
  // The cursor filter preserves the sort: rows strictly after
  // (memberCount, did) under (member_count desc, did asc) ordering — i.e.
  // member_count < cursor.memberCount, OR equal member_count AND did >
  // cursor.did. member count binds twice (used in both branches).
  const cursorClause = cursor
    ? `and (member_count < ? or (member_count = ? and cs.entity > ?))`
    : "";

  const rows = await db
    .query(
      `select
         cs.entity as did,
         ci.name as name,
         (
           select count(*) from edges
            where head = cs.entity and label in ('member','admin')
         ) as member_count,
         (
           select count(*) from events.stream_events where stream_id = cs.entity
         ) as total_events,
         (
           select count(*) from events.stream_events
            where stream_id = cs.entity and created_at >= ?
         ) as events_today
       from comp_space cs
       left join comp_info ci on ci.entity = cs.entity
      where 1=1 ${cursorClause}
       order by member_count desc, cs.entity asc
       limit ?`,
    )
    .all<{
      did: string;
      name: string | null;
      member_count: number;
      total_events: number;
      events_today: number;
    }>(
      cursor
        ? [todayStart, cursor.memberCount, cursor.memberCount, cursor.did, limit + 1]
        : [todayStart, limit + 1],
    );

  // Fetch one extra row to detect a next page without a second query.
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // ── Event-type breakdown per space (one grouped query per space) ──────
  const spaces: AdminSpaceStats[] = [];
  for (const r of pageRows) {
    const breakdownRows = await db
      .query(
        `select event_type, count(*) as n
           from events.stream_events
          where stream_id = ? and event_type is not null
          group by event_type
          order by n desc`,
      )
      .all<{ event_type: string; n: number }>(r.did);

    const eventBreakdown: Record<string, number> = {};
    for (const b of breakdownRows) {
      eventBreakdown[b.event_type] = b.n;
    }

    spaces.push({
      did: r.did,
      name: r.name ?? r.did,
      memberCount: r.member_count,
      totalEvents: r.total_events,
      eventsToday: r.events_today,
      eventBreakdown,
    });
  }

  const result: ListSpacesResult = { spaces };
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    result.cursor = `${last.member_count}|${last.did}`;
  }
  return result;
};