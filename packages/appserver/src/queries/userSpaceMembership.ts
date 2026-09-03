/**
 * Durable user-space membership intent, stored in the read-state DB.
 *
 * This is the appserver's source of truth for *which spaces a user intends to
 * participate in* during the transition to ATProto permission records. It is
 * written transactionally alongside join/leave events and read by getSpaces,
 * hydration and the activity feed.
 *
 * Actual space access (member/admin/ban) remains derived from the space's own
 * per-space DB — this table only records intent, so a `joined` row does not by
 * itself grant access.
 */

import type { DbLike } from "../db/types.ts";
import type { StreamDid, UserDid } from "@roomy-space/sdk";

export type MembershipState = "joined" | "left";

/** A join/leave event reduced to a durable membership intent. */
export interface MembershipIntent {
  userDid: string;
  spaceDid: string;
  state: MembershipState;
  eventId: string;
  source: string;
}

/**
 * Classify a decoded join/leave event into a membership intent, or null for
 * non-membership events. Shared by the boot recovery migration (which scans
 * the raw event log) and the live materialisation path (applyBundle), so both
 * agree on which events update `user_space_membership` and how the space DID
 * is derived.
 *
 * Current space-side events carry the space as the stream the event lives in
 * (`streamId`); deprecated personal-stream events carry it in the payload
 * (`spaceDid`); the two legacy variants nest it under `variant`.
 */
export function classifyMembershipEvent(
  event: any,
  streamId: string,
  user: string,
): MembershipIntent | null {
  const $type = event?.$type;
  const variant = event?.variant;

  if ($type === "space.roomy.space.joinSpace.v0") {
    return { userDid: user, spaceDid: streamId, state: "joined", eventId: event.id, source: "space.joinSpace" };
  }
  if ($type === "space.roomy.space.leaveSpace.v0") {
    return { userDid: user, spaceDid: streamId, state: "left", eventId: event.id, source: "space.leaveSpace" };
  }
  if ($type === "space.roomy.space.personal.joinSpace.v0") {
    return { userDid: user, spaceDid: event.spaceDid, state: "joined", eventId: event.id, source: "personal.joinSpace" };
  }
  if ($type === "space.roomy.space.personal.leaveSpace.v0") {
    return { userDid: user, spaceDid: event.spaceDid, state: "left", eventId: event.id, source: "personal.leaveSpace" };
  }
  if (variant?.$type === "space.roomy.stream.personal.joinSpace.v0") {
    return { userDid: user, spaceDid: variant.spaceDid, state: "joined", eventId: event.id, source: "stream.personal.joinSpace" };
  }
  if (variant?.$type === "space.roomy.personal.joinSpace.v0") {
    return { userDid: user, spaceDid: variant.spaceId, state: "joined", eventId: event.id, source: "legacy.personal.joinSpace" };
  }
  return null;
}

export interface UserSpaceMembershipRow {
  user_did: string;
  space_did: string;
  state: MembershipState;
  source: string;
  source_event_id: string;
  updated_at: number;
}

/**
 * Record a user's membership intent for a space. One row per (user, space);
 * the latest write wins. Idempotent — re-joining or re-leaving just updates
 * the row.
 */
export async function setUserSpaceMembership(
  db: DbLike,
  userDid: UserDid,
  spaceDid: StreamDid,
  state: MembershipState,
  source: string,
  sourceEventId: string,
): Promise<void> {
  await db.run(
    `insert into user_space_membership
       (user_did, space_did, state, source, source_event_id, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(user_did, space_did) do update set
       state = excluded.state,
       source = excluded.source,
       source_event_id = excluded.source_event_id,
       updated_at = excluded.updated_at`,
    [userDid, spaceDid, state, source, sourceEventId, Date.now()],
  );
}

/**
 * Return the space DIDs the user has joined and not left (active intent).
 */
export async function selectJoinedSpaceDids(
  db: DbLike,
  userDid: UserDid,
): Promise<StreamDid[]> {
  const rows = await db
    .query(
      `select space_did as id
         from user_space_membership
        where user_did = ? and state = 'joined'
        order by updated_at desc`,
    )
    .all<{ id: string }>([userDid]);
  return rows.map((r) => r.id as StreamDid);
}

export interface UserSpaceRow {
  space_did: string;
  state: MembershipState;
}

/**
 * Return all membership rows for a user, optionally including left spaces.
 * When `includeLeft` is false, only `joined` rows are returned.
 */
export async function selectUserSpaces(
  db: DbLike,
  userDid: UserDid,
  includeLeft = false,
): Promise<UserSpaceRow[]> {
  const rows = await db
    .query(
      `select usm.space_did, usm.state
         from user_space_membership usm
         left join space_order so
           on so.user_did = usm.user_did and so.space_did = usm.space_did
        where usm.user_did = ? ${includeLeft ? "" : "and usm.state = 'joined'"}
        order by
          case when so.position is null then 1 else 0 end,
          so.position asc,
          usm.updated_at desc`,
    )
    .all<{ space_did: string; state: MembershipState }>([userDid]);
  return rows.map((r) => ({ space_did: r.space_did, state: r.state }));
}
