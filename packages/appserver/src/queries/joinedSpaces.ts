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

import type { DbLike } from "../db/types.ts";
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
  handle?: string;
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
async function rowToSpace(
  db: DbLike,
  r: {
    id: string;
    name: string | null;
    avatar: string | null;
    description: string | null;
    handle: string | null;
    is_member: number;
    is_admin: number;
  },
  userDid: UserDid,
): Promise<SpaceRow> {
  const space: SpaceRow = {
    id: r.id,
    unreadCount: await getSpaceUnreadCount(db, userDid, r.id),
    isMember: !!r.is_member,
    isAdmin: !!r.is_admin,
    roleIds: [],
  };
  if (r.name !== null) space.name = r.name;
  if (r.avatar !== null) space.avatar = r.avatar;
  if (r.description !== null) space.description = r.description;
  if (r.handle !== null) space.handle = r.handle;
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
export async function selectJoinedSpaces(
  db: DbLike,
  userDid: UserDid,
  personalStreamDid: StreamDid,
  options: SelectSpacesOptions = {},
): Promise<SpaceRow[]> {
  if (options.includeLeft) {
    return await selectJoinedAndLeftSpaces(db, userDid, personalStreamDid);
  }
  return await selectJoinedSpacesOnly(db, userDid, personalStreamDid);
}

/**
 * Joined spaces only — the original behaviour. Requires the user to have
 * a `member` or `admin` edge on the space (in addition to the `joinedSpace`
 * edge from the personal stream).
 */
async function selectJoinedSpacesOnly(
  db: DbLike,
  userDid: UserDid,
  personalStreamDid: StreamDid,
): Promise<SpaceRow[]> {
  const rows = await db
    .query(
      `select
           je.tail as id,
           ci.name as name,
           ci.avatar as avatar,
           ci.description as description,
           cs.handle as handle,
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
         left join comp_space cs on cs.entity = je.tail
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
    .all<{
      id: string;
      name: string | null;
      avatar: string | null;
      description: string | null;
      handle: string | null;
      is_member: number;
      is_admin: number;
    }>([userDid, personalStreamDid, JOINED_SPACE_LABEL]);

  return await Promise.all(rows.map((r) => rowToSpace(db, r, userDid)));
}

/**
 * Joined + left spaces. Returns spaces with either a `joinedSpace` edge
 * (currently joined) OR a `leftSpace` edge (previously left). The
 * `isMember`/`isAdmin` fields correctly reflect the current membership
 * state — left spaces have both as false.
 */
async function selectJoinedAndLeftSpaces(
  db: DbLike,
  userDid: UserDid,
  personalStreamDid: StreamDid,
): Promise<SpaceRow[]> {
  const rows = await db
    .query(
      `select
           je.tail as id,
           ci.name as name,
           ci.avatar as avatar,
           ci.description as description,
           cs.handle as handle,
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
         left join comp_space cs on cs.entity = je.tail
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
    .all<{
      id: string;
      name: string | null;
      avatar: string | null;
      description: string | null;
      handle: string | null;
      is_member: number;
      is_admin: number;
    }>([userDid, personalStreamDid, JOINED_SPACE_LABEL, LEFT_SPACE_LABEL]);

  return await Promise.all(rows.map((r) => rowToSpace(db, r, userDid)));
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
export async function recordPersonalSpaceMembership(
  db: DbLike,
  spaceId: StreamDid,
  personalStreamDid: StreamDid,
): Promise<void> {
  const now = Date.now();
  // The `joinedSpace` edge has FKs to both entity rows. Each entity is
  // scoped to its own stream — the space entity belongs to the space stream,
  // never the personal stream — so seed both with stream_id = id. Existing
  // rows are left untouched (their stream_id is already correct).
  await db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [spaceId, spaceId, now],
  );
  await db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [personalStreamDid, personalStreamDid, now],
  );
  await db.run(`insert or ignore into edges (head, tail, label) values (?, ?, ?)`, [
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
export async function recordLeftSpaceEdge(
  db: DbLike,
  spaceId: StreamDid,
  personalStreamDid: StreamDid,
): Promise<void> {
  const now = Date.now();
  // Seed entity rows if they don't exist yet.
  await db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [spaceId, spaceId, now],
  );
  await db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [personalStreamDid, personalStreamDid, now],
  );
  await db.run(`insert or ignore into edges (head, tail, label) values (?, ?, ?)`, [
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
export async function removeLeftSpaceEdge(
  db: DbLike,
  spaceId: StreamDid,
  personalStreamDid: StreamDid,
): Promise<void> {
  await db.run(
    `delete from edges
      where head = ? and tail = ? and label = ?`,
    [personalStreamDid, spaceId, LEFT_SPACE_LABEL],
  );
}
