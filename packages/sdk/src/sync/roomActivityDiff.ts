/**
 * Hardcoded room-activity-diff applicator.
 *
 * Companion to {@link applyMessageDiff} and the `#roomMetadataDiff` patchers:
 * applies one `#roomActivityDiff` frame to the activity-ordered views, so a new
 * message moves its room up the board instead of forcing a refetch of every
 * board for every reader.
 *
 * ## What the frame means
 *
 * A message just landed in `roomId` and is now that room's latest activity. The
 * activity-ordered views are:
 *
 *   - `space.roomy.space.getThreads` — the space index board (infinite query)
 *   - `space.roomy.room.getThreads`  — a channel's thread board (infinite query)
 *   - `room.getMetadata.recentThreads` — a channel's in-chat thread list
 *
 * All three order newest-activity-first and are therefore *pages*: the server
 * returns the newest N, and moving a room to the front drops the previous
 * occupant of the last slot. That is exactly reproducible client-side when the
 * room is already in the cached page (move to front, truncate to the original
 * length), and NOT reproducible when it isn't (the room has to displace a row
 * we never loaded). Rather than assert an order the server would not return,
 * the patcher reports the miss and the router falls back to invalidating that
 * query, which is always correct.
 *
 * ## Backdated messages
 *
 * The board's displayed `latestTimestamp` is the room's MAX message timestamp
 * (`fetchRoomActivity` groups by room with `max(...)`), not the newest arrival:
 * a Discord-bridged message carrying an old `timestampOverride` does not lower
 * it. The diff carries the arriving message's timestamp, so when it does not
 * exceed the cached one the frame cannot describe the resulting order — the
 * patcher reports a miss and the query refetches.
 *
 * ## What is NOT patched here
 *
 * Caller-scoped fields (`unreadCount`, `unread`, `lastRead`) are per-user and
 * therefore absent from this frame by design; they ride on `#roomMetadataDiff`,
 * which is already delivered per affected user. The board rows' unread fields
 * are patched from THAT frame (see `patchBoardUnread`), not this one.
 */

import { Response as SpaceThreadsResponse } from "../schemas/queries/getSpaceThreads";
import { Response as RoomThreadsResponse } from "../schemas/queries/getRoomThreads";
import { Response as RoomMetadataResponse } from "../schemas/queries/getRoomMetadata";
import type { Body as RoomActivityDiffBody } from "../schemas/frames/roomActivityDiff";

/** The wire shapes these patchers read and write. */
export type SpaceThreadsData = typeof SpaceThreadsResponse.infer;
export type RoomThreadsData = typeof RoomThreadsResponse.infer;
export type RoomMetadataData = typeof RoomMetadataResponse.infer;

type SpaceRoom = SpaceThreadsData["rooms"][number];
type RoomThreadRow = RoomThreadsData["threads"][number];
type ThreadActivity = SpaceRoom["activity"];

/** The frame body, as validated by the router. */
export type RoomActivityPatch = typeof RoomActivityDiffBody.infer;

/**
 * A paginated board's cached shape (TanStack infinite query). `pages[0]` is
 * what the user is looking at; later pages are loaded on scroll.
 */
export type InfiniteData<T> = { pages: T[]; pageParams: unknown[] };

/**
 * Board participant cap. Mirrors the server's `fetchRoomActivity`, which keeps
 * the newest 3 distinct authors per room — the client must produce the same
 * list the server would.
 */
const MAX_BOARD_MEMBERS = 3;

/**
 * Merge the diff's participants into a cached board list, and build the
 * `activity` object a refetch would return.
 *
 * The server's member list is the room's newest 3 distinct authors, newest
 * first; the frame carries only the author this message added. Since that
 * author is now the most recent, the resulting list is that author followed by
 * the previous ones with it removed — an exact reproduction of the aggregate,
 * which is why the frame can stay one member wide.
 */
function nextActivity(
  prev: ThreadActivity,
  patch: RoomActivityPatch,
): ThreadActivity {
  const incoming = patch.activity.latestMembers;
  const incomingDids = new Set(incoming.map((m) => m.did));
  const latestMembers = [
    ...incoming,
    ...prev.latestMembers.filter((m) => !incomingDids.has(m.did)),
  ].slice(0, MAX_BOARD_MEMBERS);

  return {
    ...(patch.activity.latestTimestamp !== undefined
      ? { latestTimestamp: patch.activity.latestTimestamp }
      : {}),
    latestMembers,
    ...(patch.activity.latestMessage !== undefined
      ? { latestMessage: patch.activity.latestMessage }
      : {}),
  };
}

/**
 * Move the row for `roomId` to the front of the board's first page, applying
 * the diff's structural fields to it.
 *
 * Returns `null` when the board cannot represent the new state: the room is not
 * on the cached first page (so a refetch would displace a row we never loaded)
 * or the message does not advance the room's activity (see file header).
 */
function patchBoardPage<Row extends { id: string; activity: ThreadActivity }>(
  page: { rooms?: Row[]; threads?: Row[] },
  key: "rooms" | "threads",
  roomId: string,
  patch: RoomActivityPatch,
  buildRow: (prev: Row, patch: RoomActivityPatch) => Row,
): { rooms?: Row[]; threads?: Row[] } | null {
  const rows = page[key] as Row[] | undefined;
  if (!rows || rows.length === 0) return null;

  const index = rows.findIndex((r) => r.id === roomId);
  if (index < 0) return null;
  const prev = rows[index]!;
  // The board's timestamp is the room's MAX message time, so only a message
  // that exceeds the cached one moves the row (see the backdated case in the
  // file header). Without an advancing timestamp the diff cannot describe the
  // resulting order.
  const patchTs = patch.activity.latestTimestamp;
  const cachedTs = prev.activity.latestTimestamp;
  if (
    patchTs === undefined ||
    (cachedTs !== undefined && Date.parse(patchTs) <= Date.parse(cachedTs))
  ) {
    return null;
  }

  // Move to front and keep the page's length: the row that was last drops off
  // the page, exactly as it would on a refetch.
  const updated = buildRow(prev, patch);
  const rest = [...rows.slice(0, index), ...rows.slice(index + 1)];
  rest.unshift(updated);
  return { ...page, [key]: rest.slice(0, rows.length) } as {
    rooms?: Row[];
    threads?: Row[];
  };
}

/**
 * Apply a room-activity diff to the space index board (`space.getThreads`,
 * an infinite query). Returns `undefined` when the state can't be represented
 * — the caller should invalidate the query.
 */
export function patchSpaceBoard(
  prev: InfiniteData<SpaceThreadsData> | undefined,
  patch: RoomActivityPatch,
): InfiniteData<SpaceThreadsData> | undefined {
  if (!prev || prev.pages.length === 0) return undefined;
  const [first, ...rest] = prev.pages;
  const patched = patchBoardPage<SpaceRoom>(
    first as { rooms?: SpaceRoom[] },
    "rooms",
    patch.roomId,
    patch,
    (row, p) => ({
      ...row,
      kind: p.kind,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.parentChannelId !== undefined ? { channel: p.parentChannelId } : {}),
      ...(p.parentChannelName !== undefined
        ? { channelName: p.parentChannelName }
        : {}),
      activity: nextActivity(row.activity, p),
    }),
  );
  if (!patched) return undefined;
  return {
    pages: [patched as SpaceThreadsData, ...rest],
    pageParams: prev.pageParams,
  };
}

/**
 * Apply a room-activity diff to a channel's thread board
 * (`room.getThreads`, an infinite query — `roomId` is the channel whose board
 * it is, `patch.roomId` the thread that moved).
 */
export function patchRoomBoard(
  prev: InfiniteData<RoomThreadsData> | undefined,
  patch: RoomActivityPatch,
): InfiniteData<RoomThreadsData> | undefined {
  if (!prev || prev.pages.length === 0) return undefined;
  const [first, ...rest] = prev.pages;
  const patched = patchBoardPage<RoomThreadRow>(
    first as { threads?: RoomThreadRow[] },
    "threads",
    patch.roomId,
    patch,
    (row, p) => ({
      ...row,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.parentChannelId !== undefined
        ? { canonicalParent: p.parentChannelId }
        : {}),
      activity: nextActivity(row.activity, p),
    }),
  );
  if (!patched) return undefined;
  return {
    pages: [patched as RoomThreadsData, ...rest],
    pageParams: prev.pageParams,
  };
}

/**
 * Apply a room-activity diff to a `room.getMetadata` response's
 * `recentThreads`.
 *
 * This list holds the room's linked threads — never the room itself (`roomId`
 * is filtered out server-side) — so a message in a channel changes nothing
 * here, and a message in a thread reorders that thread only within its PARENT
 * channel's list (callers pass the parent's key). A list that does not contain
 * the room is therefore a genuine no-op, not a miss: return `prev` unchanged.
 *
 * Returns `undefined` when there is no cached entry (a no-op for
 * `setQueryData`), matching the other metadata patchers.
 */
export function patchRecentThreads(
  prev: RoomMetadataData | undefined,
  patch: RoomActivityPatch,
): RoomMetadataData | undefined {
  if (!prev) return undefined;
  const index = prev.recentThreads.findIndex((t) => t.id === patch.roomId);
  if (index < 0) return prev;

  const row = prev.recentThreads[index]!;
  const moved = {
    ...row,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
  };
  const rest = [
    ...prev.recentThreads.slice(0, index),
    ...prev.recentThreads.slice(index + 1),
  ];
  return { ...prev, recentThreads: [moved, ...rest] };
}

// ─── Caller-scoped board fields (from #roomMetadataDiff) ─────────────────

/**
 * Patch the unread fields of a board row from a `#roomMetadataDiff`.
 *
 * The board rows' `unreadCount` / `unread` are per-user, so they are absent
 * from the broadcast activity diff and arrive on the per-user metadata frame
 * instead — the one that already patches `getSpaces`, the sidebar and
 * `room.getMetadata.unreadCount` for the same event.
 *
 * `unread` is only ever set TRUE (a row with a new message is unread for every
 * recipient of the frame, who all have a read-position row for the room). It is
 * never cleared here: the frame's recipients are not necessarily looking at the
 * room, and clearing is the job of the reader's own `updateSeen`, which
 * invalidates these queries for that user.
 */
function patchRowUnread<
  Row extends { id: string; unreadCount?: number; unread?: boolean },
>(rows: Row[], roomId: string, delta: number): Row[] {
  let found = false;
  const next = rows.map((row) => {
    if (row.id !== roomId) return row;
    found = true;
    const unreadCount = (row.unreadCount ?? 0) + delta;
    return {
      ...row,
      unreadCount,
      ...(unreadCount > 0 ? { unread: true } : {}),
    };
  });
  return found ? next : rows;
}

/** Patch a cached space board's room row from a per-user unread delta. */
export function patchSpaceBoardUnread(
  prev: InfiniteData<SpaceThreadsData> | undefined,
  roomId: string,
  delta: number,
): InfiniteData<SpaceThreadsData> | undefined {
  if (!prev) return undefined;
  return {
    pages: prev.pages.map((page) => ({
      ...page,
      rooms: patchRowUnread(page.rooms, roomId, delta),
    })),
    pageParams: prev.pageParams,
  };
}

/** Patch a cached room-threads board's row from a per-user unread delta. */
export function patchRoomBoardUnread(
  prev: InfiniteData<RoomThreadsData> | undefined,
  roomId: string,
  delta: number,
): InfiniteData<RoomThreadsData> | undefined {
  if (!prev) return undefined;
  return {
    pages: prev.pages.map((page) => ({
      ...page,
      threads: patchRowUnread(page.threads, roomId, delta),
    })),
    pageParams: prev.pageParams,
  };
}
