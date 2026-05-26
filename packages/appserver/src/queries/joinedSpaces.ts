/**
 * Joined-spaces query + personal-membership recording.
 *
 * `selectJoinedSpaces` is the SQL behind `space.roomy.space.getSpaces`:
 * the union of personal-stream join intent and per-space membership truth.
 *
 * `recordPersonalSpaceMembership` writes the rows that query depends on
 * directly, used by `createSpace` to make a freshly-created space visible
 * without depending on personal-stream materialisation ordering/timing.
 */

import type { Database } from "bun:sqlite";
import type { StreamDid, UserDid } from "@roomy-space/sdk";
import { getSpaceUnreadCount } from "./readPositions.ts";

/**
 * Edge label for personal-stream join intent: `head` is the user's personal
 * stream, `tail` is the joined space. Membership is per-(user, space), so it
 * must live in `edges` (a many-to-many table) rather than on the single
 * global `comp_space` / `entities` row a space has.
 *
 * Must match the label written by the SDK's `PersonalJoinSpace` /
 * `PersonalLeaveSpace` materialisers.
 */
export const JOINED_SPACE_LABEL = "joinedSpace";

/**
 * Edge label for tracking spaces the user has left. Written directly to the
 * DB by the leaveSpace handler (bypassing the event stream), so the space
 * remains visible when `includeLeft = true`.
 */
export const LEFT_SPACE_LABEL = "leftSpace";

export interface SpaceRow {
  id: string;
  name?: string;
  avatar?: string;
  description?: string;
  unreadCount: number;
  isMember: boolean;
  isAdmin: boolean;
  roleIds: string[];
}

export interface SelectSpacesOptions {
  /** When true, also return spaces the user has left (isMember = false). */
  includeLeft?: boolean;
}

/**
 * Map a raw SQL row to a SpaceRow.
 */
function rowToSpace(
  db: Database,
  r: {
    id: string;
    name: string | null;
    avatar: string | null;
    description: string | null;
    is_member: number;
    is_admin: number;
  },
  userDid: UserDid,
): SpaceRow {
  const space: SpaceRow = {
    id: r.id,
    unreadCount: getSpaceUnreadCount(db, userDid, r.id),
    isMember: !!r.is_member,
    isAdmin: !!r.is_admin,
    roleIds: [],
  };
  if (r.name !== null) space.name = r.name;
  if (r.avatar !== null) space.avatar = r.avatar;
  if (r.description !== null) space.description = r.description;
  return space;
}

/**
 * Return the caller's joined spaces, optionally including left spaces.
 *
 * A joined space is identified by a `joinedSpace` edge from the caller's
 * personal stream to the space. The edge carries the join intent; the space
 * stream's own `member`/`admin` edges carry the actual membership truth.
 *
 * When `includeLeft` is true, left spaces (identified by a `leftSpace` edge)
 * are also returned with `isMember = false`, `isAdmin = false`.
 */
export function selectJoinedSpaces(
  db: Database,
  userDid: UserDid,
  personalStreamDid: StreamDid,
  options: SelectSpacesOptions = {},
): SpaceRow[] {
  if (options.includeLeft) {
    return selectJoinedAndLeftSpaces(db, userDid, personalStreamDid);
  }
  return selectJoinedSpacesOnly(db, userDid, personalStreamDid);
}

/**
 * Joined spaces only — the original behaviour. Requires the user to have
 * a `member` or `admin` edge on the space (in addition to the `joinedSpace`
 * edge from the personal stream).
 */
function selectJoinedSpacesOnly(
  db: Database,
  userDid: UserDid,
  personalStreamDid: StreamDid,
): SpaceRow[] {
  const rows = db
    .query<
      {
        id: string;
        name: string | null;
        avatar: string | null;
        description: string | null;
        is_member: number;
        is_admin: number;
      },
      [string, string, string]
    >(
      `select
           je.tail as id,
           ci.name as name,
           ci.avatar as avatar,
           ci.description as description,
           exists (
             select 1 from edges
              where head = je.tail and tail = ?1 and label = 'member'
           ) as is_member,
           exists (
             select 1 from edges
              where head = je.tail and tail = ?1 and label = 'admin'
           ) as is_admin
         from edges je
         left join comp_info ci on ci.entity = je.tail
        where je.head = ?2
          and je.label = ?3
          and not exists (
            select 1 from comp_bans
             where entity = je.tail and user_did = ?1
          )
          and (
            exists (
              select 1 from edges
               where head = je.tail and tail = ?1 and label = 'member'
            )
            or exists (
              select 1 from edges
               where head = je.tail and tail = ?1 and label = 'admin'
            )
          )`,
    )
    .all(userDid, personalStreamDid, JOINED_SPACE_LABEL);

  return rows.map((r) => rowToSpace(db, r, userDid));
}

/**
 * Joined + left spaces. Returns spaces with either a `joinedSpace` edge
 * (currently joined) OR a `leftSpace` edge (previously left). The
 * `isMember`/`isAdmin` fields correctly reflect the current membership
 * state — left spaces have both as false.
 */
function selectJoinedAndLeftSpaces(
  db: Database,
  userDid: UserDid,
  personalStreamDid: StreamDid,
): SpaceRow[] {
  const rows = db
    .query<
      {
        id: string;
        name: string | null;
        avatar: string | null;
        description: string | null;
        is_member: number;
        is_admin: number;
      },
      [string, string, string, string]
    >(
      `select
           je.tail as id,
           ci.name as name,
           ci.avatar as avatar,
           ci.description as description,
           exists (
             select 1 from edges
              where head = je.tail and tail = ?1 and label = 'member'
           ) as is_member,
           exists (
             select 1 from edges
              where head = je.tail and tail = ?1 and label = 'admin'
           ) as is_admin
         from edges je
         left join comp_info ci on ci.entity = je.tail
        where je.head = ?2
          and (
            je.label = ?3   -- joinedSpace
            or je.label = ?4  -- leftSpace
          )
          and not exists (
            select 1 from comp_bans
             where entity = je.tail and user_did = ?1
          )
          and (
            je.label = ?4  -- leftSpace → always include
            or exists (
              select 1 from edges
               where head = je.tail and tail = ?1 and label = 'member'
            )
            or exists (
              select 1 from edges
               where head = je.tail and tail = ?1 and label = 'admin'
            )
          )`,
    )
    .all(userDid, personalStreamDid, JOINED_SPACE_LABEL, LEFT_SPACE_LABEL);

  return rows.map((r) => rowToSpace(db, r, userDid));
}

/**
 * Record that `personalStreamDid` has joined `spaceId` by writing the
 * `joinedSpace` edge `selectJoinedSpaces` reads.
 *
 * Why this exists: `createSpace` materialises the new space and writes the
 * `personal.joinSpace` event, but the personal stream's live materialisation
 * of that event may not have landed by the time the HTTP response returns.
 * Writing the edge directly makes the new space visible to the immediately
 * following `getSpaces` call regardless of materialisation timing.
 *
 * The writes mirror the SDK's `PersonalJoinSpace` materialiser and are
 * idempotent, so the later live materialisation of the same event is a
 * harmless no-op.
 */
export function recordPersonalSpaceMembership(
  db: Database,
  spaceId: StreamDid,
  personalStreamDid: StreamDid,
): void {
  const now = Date.now();
  // The `joinedSpace` edge has FKs to both entity rows. Each entity is
  // scoped to its own stream — the space entity belongs to the space stream,
  // never the personal stream — so seed both with stream_id = id. Existing
  // rows are left untouched (their stream_id is already correct).
  db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [spaceId, spaceId, now],
  );
  db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [personalStreamDid, personalStreamDid, now],
  );
  db.run(`insert or ignore into edges (head, tail, label) values (?, ?, ?)`, [
    personalStreamDid,
    spaceId,
    JOINED_SPACE_LABEL,
  ]);
}

/**
 * Record that `personalStreamDid` has left `spaceId` by writing a `leftSpace`
 * edge. This makes the space visible to subsequent `getSpaces?includeLeft=true`
 * calls with `isMember = false`.
 *
 * Called by the leaveSpace handler after the personal stream materializer
 * has drained (which deletes the `joinedSpace` edge).
 */
export function recordLeftSpaceEdge(
  db: Database,
  spaceId: StreamDid,
  personalStreamDid: StreamDid,
): void {
  const now = Date.now();
  // Seed entity rows if they don't exist yet.
  db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [spaceId, spaceId, now],
  );
  db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [personalStreamDid, personalStreamDid, now],
  );
  db.run(`insert or ignore into edges (head, tail, label) values (?, ?, ?)`, [
    personalStreamDid,
    spaceId,
    LEFT_SPACE_LABEL,
  ]);
}

/**
 * Remove a `leftSpace` edge, used when a user rejoins a space they had left.
 * Called by the joinSpace handler after the personal stream materializer
 * has drained.
 */
export function removeLeftSpaceEdge(
  db: Database,
  spaceId: StreamDid,
  personalStreamDid: StreamDid,
): void {
  db.run(
    `delete from edges
      where head = ? and tail = ? and label = ?`,
    [personalStreamDid, spaceId, LEFT_SPACE_LABEL],
  );
}
