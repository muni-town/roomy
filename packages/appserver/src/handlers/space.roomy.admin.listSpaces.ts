/**
 * XRPC: space.roomy.admin.listSpaces (query).
 *
 * Paginated, per-space stats for the admin dashboard. Each row carries
 * member/event counters and an event-type breakdown for one space. Rows
 * are ordered numerically descending by the active sort key
 * (`memberCount` | `totalEvents` | `eventsToday`, default `memberCount`),
 * ties broken by space DID ascending so the order is stable across pages.
 *
 * The cursor is `"<sortValue>|<did>"` of the last row on the current page,
 * where `<sortValue>` is that row's value under the ACTIVE sort key — the
 * number the cursor filters against is the same one the ORDER BY used, so
 * paging never re-visits or skips rows when a non-default sort is in
 * effect. The next page starts strictly after that (sort value, did) under
 * the same sort. Capped at 100 rows per page.
 *
 * ── Cost model ──────────────────────────────────────────────────────────
 *
 * This handler opens only the page's spaces. The floor is one grouped scan of
 * the event log (`group by stream_id`, an index scan over the `(stream_id, idx)`
 * primary key: ~0.5 s for 436k events), which is what enumerates the space
 * list and its event counters. Opening every space's DB to count member edges
 * and slicing the page last would make `limit` buy nothing — a 4276-space
 * dataset costs ~19 s and ~4200 DB worker round-trips per request, past the
 * request timeout. Everything per-space — the member count and the
 * display name — is either precomputed or read for the page only:
 *
 *   - Member counts come from the global `space_stats` aggregate
 *     (schema-global.sql), kept current by `applyBatch` whenever a
 *     membership-changing event materialises, and reconciled by the boot
 *     per-space sweep in `reMaterializeFromLocalEvents`. A space's member
 *     edges live only in its own DB, so precomputing this is what lets the
 *     ordering run without opening every space.
 *   - The event-volume sorts order and limit entirely in the event log.
 *   - Names are read from each space's `comp_info`, for the page only.
 *
 * `space_stats` and `stream_events` live on different workers (global and
 * events), so the member-count ordering merges the two reads in memory rather
 * than joining in SQL. Both reads are compact (`did` + two integers, and
 * `did` + one integer) and take a few milliseconds, against the grouped event
 * scan they sit on top of.
 *
 * Invariant: a space with members always HAS a `space_stats` row. Its member
 * edges can only come from an event that publishes on materialisation
 * (joinSpace / leaveSpace / addAdmin / removeAdmin / the synthetic spaceMeta —
 * see MEMBERSHIP_EVENT_TYPES in materialization/applyBatch.ts) or from space
 * data predating the aggregate, which the boot sweep reconciles. That is what
 * makes `coalesce(member_count, 0)` exact rather than a guess for
 * spaces that have no row. The sweep is not awaited before serving (neither is
 * the sibling `entity_space` backfill), so a request in the boot window can
 * under-report for a space the sweep has not reached yet; that is what the
 * refresh pass below is for, and the correction is persisted.
 *
 * Authorisation: admin allowlist (`APPSERVER_ADMIN_DIDS`).
 */

import { openDb, openGlobalDb } from "../db/db.ts";
import { requireAdmin } from "../admin.ts";
import { optionalInt, optionalString } from "../xrpc/params.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { refreshSpaceStats } from "../queries/spaceStats.ts";
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

/** The supported sort keys for the per-space list. */
export type ListSpacesSort = "memberCount" | "totalEvents" | "eventsToday";

const SORTS: readonly ListSpacesSort[] = [
  "memberCount",
  "totalEvents",
  "eventsToday",
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * How many times the page may be re-selected after a refresh pass. Each pass
 * refreshes at most `limit + 1` aggregate rows and ends as soon as the page is
 * unchanged, so this only bounds the pathological case where a space's member
 * count keeps moving between the select and the refresh.
 */
const MAX_REFRESH_PASSES = 4;

/**
 * Parse the opaque cursor into `{ sortValue, did }`. Returns null when
 * the cursor is absent or malformed (the handler treats null as "first
 * page" rather than erroring, so a stale client cursor degrades to a
 * fresh first page instead of a 400).
 *
 * The cursor is `"<sortValue>|<did>"`, where `<sortValue>` is the last
 * row's value under the ACTIVE sort key; `|` is chosen because it never
 * appears in a DID (`did:plc:` / `did:web:` use only colons).
 */
function parseCursor(
  cursor: string,
): { sortValue: number; did: string } | null {
  const sep = cursor.indexOf("|");
  if (sep <= 0 || sep === cursor.length - 1) return null;
  const sortValue = Number(cursor.slice(0, sep));
  const did = cursor.slice(sep + 1);
  if (!Number.isInteger(sortValue) || sortValue < 0 || did.length === 0)
    return null;
  return { sortValue, did };
}

/** Parse the `sort` query param, defaulting to `memberCount`. */
function parseSort(params: QueryParams): ListSpacesSort {
  const raw = optionalString(params, "sort");
  if (raw === undefined) return "memberCount";
  if ((SORTS as readonly string[]).includes(raw)) return raw as ListSpacesSort;
  throw new XrpcError(
    400,
    "InvalidRequest",
    `Param sort must be one of: ${SORTS.join(", ")}; got: ${raw}`,
  );
}

/** One space with its counters, before name/breakdown are filled in. */
interface SpaceCounters {
  did: string;
  total_events: number;
  events_today: number;
}

/** A row for the page: counters plus the member count to sort on. */
interface PageRow extends SpaceCounters {
  member_count: number;
}

/** The sort key's value on a page row. */
function sortValueOf(sort: ListSpacesSort, r: PageRow): number {
  switch (sort) {
    case "memberCount":
      return r.member_count;
    case "totalEvents":
      return r.total_events;
    case "eventsToday":
      return r.events_today;
  }
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
  const sort = parseSort(params);
  const cursorRaw = optionalString(params, "cursor") ?? null;
  const cursor = cursorRaw ? parseCursor(cursorRaw) : null;

  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const todayStart = todayMidnight.getTime();

  const counters = await selectSpaceCounters(todayStart);
  let stats =
    sort === "memberCount" ? await selectSpaceStats() : new Map<string, number>();

  // ── Fill in member counts the aggregate cannot answer for ───────────────
  //
  // A space with no `space_stats` row has never been swept, so its true member
  // count is unknown — not necessarily 0. Every such row therefore has to be
  // resolved BEFORE the ordering can be trusted, not just the ones that happen
  // to land on the current page: an unswept space sorts as if it had no
  // members, so leaving any unresolved can push a space with members below the
  // page boundary.
  //
  // In steady state this loop does nothing: the boot sweep writes a row for
  // every space it visits, INCLUDING a count of 0, so "no row" is rare and
  // short-lived. It is non-empty only for spaces the sweep has not reached yet
  // — during the boot window, or a space materialised since. Resolving them
  // both repairs the page and persists the correction, so the following
  // request is fast.
  if (sort === "memberCount") {
    const db = openDb();
    for (let pass = 0; pass < MAX_REFRESH_PASSES; pass++) {
      const unknown = counters
        .filter((c) => !stats.has(c.did))
        .map((c) => c.did);
      if (unknown.length === 0) break;
      await Promise.all(unknown.map((did) => refreshSpaceStats(db, did)));
      stats = await selectSpaceStats();
    }
  }

  const page = selectPage(counters, stats, sort, cursor, limit);

  const hasMore = page.length > limit;
  const visibleRows = hasMore ? page.slice(0, limit) : page;

  const eventBreakdownBySpace = await selectEventBreakdowns(
    visibleRows.map((r) => r.did),
  );
  const nameBySpace = await selectNames(visibleRows.map((r) => r.did));

  const spaces: AdminSpaceStats[] = visibleRows.map((r) => ({
    did: r.did,
    name: nameBySpace.get(r.did) ?? r.did,
    memberCount: r.member_count,
    totalEvents: r.total_events,
    eventsToday: r.events_today,
    eventBreakdown: eventBreakdownBySpace.get(r.did) ?? {},
  }));

  const result: ListSpacesResult = { spaces };
  if (hasMore && visibleRows.length > 0) {
    const last = visibleRows[visibleRows.length - 1]!;
    result.cursor = `${sortValueOf(sort, last)}|${last.did}`;
  }
  return result;
};

/**
 * Order the space list and cut the page (up to `limit + 1` rows, so the caller
 * can tell whether a next page exists without a second query).
 *
 * Pure and synchronous: every number it needs has already been read. For
 * `memberCount` the ordering key comes from the aggregate, which the caller
 * has made exhaustive; for the event-volume sorts it is already in the
 * counters. Ordering in memory is not a fallback but the only option for
 * `memberCount` — the key lives in the global DB on a different pool worker,
 * so it cannot be ordered against `stream_events` in SQL. Against a few
 * thousand rows of two integers this is a few milliseconds, next to the
 * grouped event scan the counters come from.
 */
function selectPage(
  counters: SpaceCounters[],
  stats: Map<string, number>,
  sort: ListSpacesSort,
  cursor: { sortValue: number; did: string } | null,
  limit: number,
): PageRow[] {
  const rows: PageRow[] = counters.map((c) => ({
    ...c,
    member_count: sort === "memberCount" ? (stats.get(c.did) ?? 0) : 0,
  }));

  const keyOf = (r: PageRow): number =>
    sort === "memberCount"
      ? r.member_count
      : sort === "eventsToday"
        ? r.events_today
        : r.total_events;

  rows.sort(
    (a, b) =>
      keyOf(b) - keyOf(a) || (a.did < b.did ? -1 : a.did > b.did ? 1 : 0),
  );

  if (cursor === null) return rows.slice(0, limit + 1);
  const cv = cursor.sortValue;
  const did = cursor.did;
  const filtered = rows.filter(
    (r) => keyOf(r) < cv || (keyOf(r) === cv && r.did > did),
  );
  return filtered.slice(0, limit + 1);
}

/**
 * Event counters for every stream in the log, from one grouped scan.
 *
 * This is the handler's floor cost (~0.5 s / 436k events on the reference
 * dataset) and the source of the space list: `group by stream_id` walks the
 * `(stream_id, idx)` primary key, and `count(*)` / the conditional `count`
 * need no table access beyond the covering index.
 */
async function selectSpaceCounters(
  todayStart: number,
): Promise<SpaceCounters[]> {
  return await openDb()
    .query(
      `select stream_id as did,
              count(*) as total_events,
              count(case when created_at >= ? then 1 end) as events_today
         from stream_events
        group by stream_id`,
    )
    .all<SpaceCounters>(todayStart);
}

/**
 * The global member-count aggregate, read compactly (`did` + one integer).
 *
 * A space with no row here has no member/admin edges — see the invariant note
 * at the top of this file.
 */
async function selectSpaceStats(): Promise<Map<string, number>> {
  const rows = await openGlobalDb()
    .query("select space_did, member_count from space_stats")
    .all<{ space_did: string; member_count: number }>();
  return new Map(rows.map((r) => [r.space_did, r.member_count]));
}

/**
 * Event-type breakdown for the visible rows, in ONE grouped query over their
 * stream ids (the original ran one query per space).
 */
async function selectEventBreakdowns(
  dids: string[],
): Promise<Map<string, Record<string, number>>> {
  const bySpace = new Map<string, Record<string, number>>();
  if (dids.length === 0) return bySpace;
  const placeholders = dids.map(() => "?").join(", ");
  const rows = await openDb()
    .query(
      `select stream_id, event_type, count(*) as n
         from stream_events
        where stream_id in (${placeholders}) and event_type is not null
        group by stream_id, event_type
        order by n desc`,
    )
    .all<{ stream_id: string; event_type: string; n: number }>(...dids);

  for (const r of rows) {
    let counts = bySpace.get(r.stream_id);
    if (!counts) {
      counts = {};
      bySpace.set(r.stream_id, counts);
    }
    counts[r.event_type] = r.n;
  }
  return bySpace;
}

/**
 * Display name per visible row, read from each space's own `comp_info`.
 *
 * This is the only per-space DB work the handler still does, and it is bounded
 * by the page size. A space whose DB has no `comp_info` row (or whose name is
 * null) falls back to the space DID, matching the previous behaviour.
 */
async function selectNames(dids: string[]): Promise<Map<string, string>> {
  const bySpace = new Map<string, string>();
  if (dids.length === 0) return bySpace;
  const db = openDb();

  const names = await Promise.all(
    dids.map(async (did) => {
      const row = await db
        .forSpace(did)
        .query("select name from comp_info where entity = ?")
        .get<{ name: string | null }>(did);
      return row?.name ?? null;
    }),
  );
  for (let i = 0; i < dids.length; i++) {
    const name = names[i];
    if (name !== null && name !== undefined) bySpace.set(dids[i]!, name);
  }
  return bySpace;
}
