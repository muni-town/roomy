/**
 * Joined-spaces query + membership recording.
 *
 * `selectJoinedSpaces` is the SQL behind `space.roomy.space.getSpaces`:
 * the union of join intent (`joinedSpace` edges from the user DID) and
 * per-space membership truth (`member`/`admin` edges).
 *
 * `recordPersonalSpaceMembership` writes the rows that query depends on
 * directly, used by `createSpace` to make a freshly-created space visible
 * without depending on materialisation ordering/timing.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, UserDid } from "@roomy-space/sdk";
import { openSpaceDb } from "../db/db.ts";
import { getSpaceUnreadStats } from "./readPositions.ts";
import { selectUserSpaces } from "./userSpaceMembership.ts";

/**
 * Edge label for join intent: `head` is the user DID, `tail` is the joined
 * space. Membership is per-(user, space), so it must live in `edges` (a
 * many-to-many table) rather than on the single global `comp_space` /
 * `entities` row a space has.
 *
 * Must match the label written by the SDK's `JoinSpace` / `LeaveSpace`
 * materialisers.
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
  /** Number of rooms (channels + engaged threads) with unread messages. */
  unreadRoomCount: number;
  isMember: boolean;
  isAdmin: boolean;
  roleIds: string[];
}

export interface SelectSpacesOptions {
  /** When true, also return spaces the user has left (isMember = false). */
  includeLeft?: boolean;
}

/**
 * Return the caller's joined spaces, optionally including left spaces.
 *
 * Membership intent is read from the read-state DB's durable
 * `user_space_membership` table (the authoritative source during the
 * transition to ATProto permission records), then fans out to each space's
 * per-space DB for display fields and membership truth (`member`/`admin`
 * edges, `comp_bans`). `readStateDb` serves both the membership intent and
 * the read-state unread-count aggregate.
 */
export async function selectJoinedSpaces(
  readStateDb: DbLike,
  userDid: UserDid,
  options: SelectSpacesOptions = {},
): Promise<SpaceRow[]> {
  const rows = await selectUserSpaces(readStateDb, userDid, options.includeLeft);

  const spaceRows = await Promise.all(
    rows.map(async (r) => {
      const isLeft = r.state === "left";
      const spaceDb = openSpaceDb(r.space_did);
      const row = await querySpaceRow(spaceDb, r.space_did, userDid);
      if (!row) return null;
      // Left spaces are always included (isMember/isAdmin false). Joined
      // spaces require a member/admin edge (real membership truth).
      if (!isLeft && !row.is_member && !row.is_admin) return null;
      const stats = await getSpaceUnreadStats(readStateDb, spaceDb, userDid, r.space_did);
      const space: SpaceRow = {
        id: r.space_did,
        unreadCount: stats.unreadCount,
        // Home cards show "rooms with unreads" — channels + engaged threads
        // (the spec's "homepage counts only count channels and active
        // threads"). The split lives on space.getMetadata for the toggles.
        unreadRoomCount: stats.unreadRoomCount + stats.unreadThreadCount,
        // A left space is never a member/admin, regardless of any stale
        // per-space member/admin edge (leaving persists those edges).
        isMember: isLeft ? false : !!row.is_member,
        isAdmin: isLeft ? false : !!row.is_admin,
        roleIds: [],
      };
      if (row.name !== null) space.name = row.name;
      if (row.avatar !== null) space.avatar = row.avatar;
      if (row.description !== null) space.description = row.description;
      if (row.handle !== null) space.handle = row.handle;
      return space;
    }),
  );

  return spaceRows.filter((s): s is SpaceRow => s !== null);
}

/**
 * Query a single space's display fields + membership truth from its per-space
 * DB. Returns null when the space isn't materialised there, or when the caller
 * is banned from it.
 */
async function querySpaceRow(
  spaceDb: DbLike,
  spaceId: string,
  userDid: UserDid,
): Promise<{
  id: string;
  name: string | null;
  avatar: string | null;
  description: string | null;
  handle: string | null;
  is_member: number;
  is_admin: number;
} | null> {
  const banned = await spaceDb
    .query(
      "select 1 as n from comp_bans where entity = ? and user_did = ? limit 1",
    )
    .get<{ n: number }>([spaceId, userDid]);
  if (banned) return null;

  // comp_info / comp_space may be absent (a space can be joined before its
  // own stream materialises a comp_space row), so read them independently.
  const info = await spaceDb
    .query("select name, avatar, description from comp_info where entity = ?")
    .get<{ name: string | null; avatar: string | null; description: string | null }>([spaceId]);
  const cs = await spaceDb
    .query("select handle from comp_space where entity = ?")
    .get<{ handle: string | null }>([spaceId]);
  const member = await spaceDb
    .query(
      "select 1 as n from edges where head = ? and tail = ? and label = 'member' limit 1",
    )
    .get<{ n: number }>([spaceId, userDid]);
  const admin = await spaceDb
    .query(
      "select 1 as n from edges where head = ? and tail = ? and label = 'admin' limit 1",
    )
    .get<{ n: number }>([spaceId, userDid]);

  return {
    id: spaceId,
    name: info?.name ?? null,
    avatar: info?.avatar ?? null,
    description: info?.description ?? null,
    handle: cs?.handle ?? null,
    is_member: member ? 1 : 0,
    is_admin: admin ? 1 : 0,
  };
}

/**
 * Record that `userDid` has joined `spaceId` by writing the `joinedSpace`
 * edge `selectJoinedSpaces` reads.
 *
 * Why this exists: `createSpace` materialises the new space and sends the
 * space-side `space.joinSpace` event, but the live materialisation of that
 * event may not have landed by the time the HTTP response returns. Writing
 * the edge directly makes the new space visible to the immediately
 * following `getSpaces` call regardless of materialisation timing.
 *
 * The writes mirror the SDK's `JoinSpace` materialiser and are idempotent,
 * so the later live materialisation of the same event is a harmless no-op.
 */
export async function recordPersonalSpaceMembership(
  db: DbLike,
  spaceId: StreamDid,
  userDid: UserDid,
): Promise<void> {
  const now = Date.now();
  // The `joinedSpace` edge has FKs to both entity rows. Each entity is
  // scoped to its own stream — the space entity belongs to the space stream,
  // never the user's — so seed both with stream_id = id. Existing rows are
  // left untouched (their stream_id is already correct).
  await db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [spaceId, spaceId, now],
  );
  await db.run(
    `insert into entities (id, stream_id, created_at) values (?, ?, ?)
     on conflict(id) do nothing`,
    [userDid, userDid, now],
  );
  await db.run(`insert or ignore into edges (head, tail, label) values (?, ?, ?)`, [
    userDid,
    spaceId,
    JOINED_SPACE_LABEL,
  ]);
}

/**
 * Record that `userDid` has left `spaceId` by writing a `leftSpace` edge.
 * This makes the space visible to subsequent `getSpaces?includeLeft=true`
 * calls with `isMember = false`.
 *
 * Called by the leaveSpace handler, which deletes the `joinedSpace` edge
 * first (no event deletes it anymore — see space.roomy.space.leaveSpace.ts).
 */
export async function recordLeftSpaceEdge(
  db: DbLike,
  spaceId: StreamDid,
  userDid: UserDid,
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
    [userDid, userDid, now],
  );
  await db.run(`insert or ignore into edges (head, tail, label) values (?, ?, ?)`, [
    userDid,
    spaceId,
    LEFT_SPACE_LABEL,
  ]);
}

/**
 * Remove a `leftSpace` edge, used when a user rejoins a space they had left.
 * Called directly by the joinSpace handler (no event removes it — see
 * space.roomy.space.joinSpace.ts).
 */
export async function removeLeftSpaceEdge(
  db: DbLike,
  spaceId: StreamDid,
  userDid: UserDid,
): Promise<void> {
  await db.run(
    `delete from edges
      where head = ? and tail = ? and label = ?`,
    [userDid, spaceId, LEFT_SPACE_LABEL],
  );
}

/**
 * Record a membership edge directly in the global DB, used by the handler
 * fast-paths (`createSpace`/`joinSpace`/`leaveSpace`) for read-after-write
 * consistency before the materialiser lands. The global DB has only the
 * `edges` table (no `entities`), so this writes just the edge — no entity
 * seeding, unlike `recordPersonalSpaceMembership` above.
 *
 * `label` is `JOINED_SPACE_LABEL` or `LEFT_SPACE_LABEL`.
 */
export async function recordGlobalMembership(
  db: DbLike,
  spaceId: StreamDid,
  userDid: UserDid,
  label: string,
): Promise<void> {
  await db.run(
    `insert or ignore into edges (head, tail, label) values (?, ?, ?)`,
    [userDid, spaceId, label],
  );
}

/**
 * Delete a membership edge from the global DB. Used by the handler
 * fast-paths to remove `joinedSpace` on leave and `leftSpace` on rejoin.
 */
export async function deleteGlobalMembership(
  db: DbLike,
  spaceId: StreamDid,
  userDid: UserDid,
  label: string,
): Promise<void> {
  await db.run(
    `delete from edges where head = ? and tail = ? and label = ?`,
    [userDid, spaceId, label],
  );
}
