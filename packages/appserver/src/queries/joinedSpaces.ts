/**
 * Joined-spaces query + membership recording.
 *
 * `selectJoinedSpaces` is the SQL behind `space.roomy.space.getSpaces`:
 * the union of durable membership intent (`user_space_membership`) and
 * per-space membership truth (`member`/`admin` edges).
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, UserDid } from "@roomy-space/sdk";
import { openSpaceDb } from "../db/db.ts";
import { getSpaceHandles } from "./spaceHandles.ts";
import { spaceHasUnreads } from "./readPositions.ts";
import { selectUserSpaces } from "./userSpaceMembership.ts";

/**
 * Edge label for join intent: `head` is the user DID, `tail` is the joined
 * space. Membership is per-(user, space), so it must live in `edges` (a
 * many-to-many table) rather than on the single `entities` row a space has.
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
  /**
   * Whether any room of this space has unread messages for the caller. A
   * level rather than a count: the per-room badges come from the sidebar,
   * and this list only needs to know whether to mark the space at all.
   *
   * A left space is never unread: it has no accessible rooms, so the probe
   * reports false. The UI filters left spaces out of the list.
   */
  hasUnreads: boolean;
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
 * the unread probe.
 */
export async function selectJoinedSpaces(
  readStateDb: DbLike,
  userDid: UserDid,
  options: SelectSpacesOptions = {},
): Promise<SpaceRow[]> {
  const rows = await selectUserSpaces(readStateDb, userDid, options.includeLeft);

  // The DNS handle lives in the global store (it is not log-derived), so it is
  // fetched for the whole page in one round-trip rather than per space.
  const handles = await getSpaceHandles(rows.map((r) => r.space_did));

  const spaceRows = await Promise.all(
    rows.map(async (r) => {
      const isLeft = r.state === "left";
      const spaceDb = openSpaceDb(r.space_did);
      const row = await querySpaceRow(spaceDb, r.space_did, userDid);
      if (!row) return null;
      // Left spaces are always included (isMember/isAdmin false). Joined
      // spaces require a member/admin edge (real membership truth).
      if (!isLeft && !row.is_member && !row.is_admin) return null;
      const handle = handles.get(r.space_did) ?? null;
      const space: SpaceRow = {
        id: r.space_did,
        hasUnreads: await spaceHasUnreads(readStateDb, spaceDb, userDid, r.space_did),
        // A left space is never a member/admin, regardless of any stale
        // per-space member/admin edge (leaving persists those edges).
        isMember: isLeft ? false : !!row.is_member,
        isAdmin: isLeft ? false : !!row.is_admin,
        roleIds: [],
      };
      if (row.name !== null) space.name = row.name;
      if (row.avatar !== null) space.avatar = row.avatar;
      if (row.description !== null) space.description = row.description;
      if (handle !== null) space.handle = handle;
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
    is_member: member ? 1 : 0,
    is_admin: admin ? 1 : 0,
  };
}

/**
 * Record a membership edge directly in the global DB, used by the handler
 * fast-paths (`createSpace`/`joinSpace`/`leaveSpace`) for read-after-write
 * consistency before the materialiser lands. The global DB has only the
 * `edges` table (no `entities`), so this writes just the edge — no entity
 * seeding.
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
