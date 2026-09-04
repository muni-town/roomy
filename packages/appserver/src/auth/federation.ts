/**
 * Channel-federation access resolution.
 *
 * Federation lets a channel owned by space A be read and written by members
 * of space B. It is a "virtual grant" layered on top of the normal per-space
 * `roomAccess`:
 *
 *   effective(A_channel, did, homeSpace=B) =
 *     origin grant    (A-admin sets read/readwrite for B on the channel)
 *     × receiver grant (B-admin sets per-member/role; Phase 3)
 *
 * Rules:
 *   - An **admin of the receiving space B** gets origin-level access (they
 *     manage the federation), so federated channels are visible to B admins
 *     before any receiver grant is set.
 *   - A **non-admin B member** needs a receiver grant (kind='user' for their
 *     DID, or kind='role' for a role they hold in B). Effective access is the
 *     more restrictive of the origin grant and the receiver grant — a
 *     receiver grant can never exceed the origin ceiling.
 *   - No receiver grant ⇒ no access for non-admin B members.
 *
 * This module is decision-only (same coupling rules as `access.ts`): it takes
 * DB handles, performs no I/O beyond queries on them, and has no XRPC/HTTP
 * awareness. It is consulted only when the native `roomAccess` denies, so
 * non-federated spaces pay no cost.
 *
 * Threads inherit from their parent channel (see plan §5.5): grants are keyed
 * on the canonical parent channel, mirroring `access.ts`'s
 * `permRoom = parentChannelId ?? roomId`.
 */

import type { DbLike } from "../db/types.ts";
import { resolveRoom, spaceAccess, type AccessMemo } from "./access.ts";

export interface FederatedRoomAccess {
  canRead: boolean;
  canWrite: boolean;
  /** The caller's home space (B) through which the federation is granted. */
  homeSpaceDid: string | null;
}

export interface FederationAccessOptions {
  /**
   * Resolve a space's per-space DB by DID. Needed to check B role membership
   * (receiver role grants) and B admin status. When omitted, only direct
   * user receiver grants and the origin grant are considered.
   */
  spaceDbResolver?: (spaceDid: string) => DbLike;
  /**
   * Per-request federation memo. When omitted, a transient memo is built for
   * this call only (dedupes the nested global queries within a single call).
   * Threading the *same* memo across a whole handler (e.g. the getMetadata
   * sidebar loop, where every federated channel re-queries the same joined-
   * spaces row and per-space B access) collapses that N×SQL fan-out.
   */
  memo?: FederationMemo;
  /**
   * Optional per-request `AccessMemo` forwarded to the `spaceAccess` calls so
   * the ~5 space-level queries per receiving space (B) are computed once per
   * request rather than once per federated channel.
   */
  accessMemo?: AccessMemo;
}

/**
 * Per-request cache for the global-DB federation lookups. It is keyed by
 * user / (origin, home) / (origin, home, room) and is intentionally
 * per-request (never process-global): federation state can change between
 * requests via events, and a stale cache would be a security bug.
 */
export interface FederationMemo {
  /** Joined-space DIDs per caller did (empty array = member of none). */
  readonly joinedSpaces: Map<string, string[]>;
  /** Active-federation existence per `${origin}\0${home}`. */
  readonly activeFederation: Map<string, boolean>;
  /** Origin grant per `${origin}\0${home}\0${room}` (null = no grant). */
  readonly originGrant: Map<string, Permission | null>;
}

/** Create a fresh per-request federation memo. */
export function createFederationMemo(): FederationMemo {
  return {
    joinedSpaces: new Map(),
    activeFederation: new Map(),
    originGrant: new Map(),
  };
}

type Permission = "read" | "readwrite";

function level(p: Permission): number {
  return p === "readwrite" ? 2 : 1;
}
/** More restrictive of two permissions (read < readwrite). */
function minPermission(a: Permission, b: Permission): Permission {
  return level(a) <= level(b) ? a : b;
}
/** Most permissive of two permissions (for combining multiple grants). */
function maxPermission(a: Permission | null, b: Permission): Permission {
  if (a === null) return b;
  return level(a) >= level(b) ? a : b;
}

function joinedKey(did: string): string {
  return did;
}
function fedKey(origin: string, home: string): string {
  return `${origin}\0${home}`;
}
function originKey(origin: string, home: string, room: string): string {
  return `${origin}\0${home}\0${room}`;
}

/**
 * Resolve a caller's federated access to a room owned by another space.
 *
 * Returns `null` when the caller has no federated access (e.g. the room isn't
 * federated to any space the caller belongs to, the relationship isn't
 * active, the caller isn't a member of the receiving space, or — for a
 * non-admin B member — there is no receiver grant).
 *
 * `did` must be non-null; anonymous callers are never federated.
 */
export async function federatedRoomAccess(
  spaceDb: DbLike, // owning (origin) space A DB
  globalDb: DbLike, // global registry DB
  roomId: string,
  did: string,
  opts: FederationAccessOptions = {},
): Promise<FederatedRoomAccess | null> {
  const { row, parentChannelId } = await resolveRoom(spaceDb, roomId);
  if (row === null || row.spaceId === null) return null;
  const originSpace = row.spaceId;
  const grantRoom = parentChannelId ?? roomId;

  const memo = opts.memo ?? createFederationMemo();

  // The caller's membership spaces (head = user DID, tail = space DID).
  // Cached per did — identical across every channel in a request.
  let homeSpaces: string[];
  if (memo.joinedSpaces.has(joinedKey(did))) {
    homeSpaces = memo.joinedSpaces.get(joinedKey(did))!;
  } else {
    const spaces = await globalDb
      .query("select tail from edges where head = ? and label = 'joinedSpace'")
      .all<{ tail: string }>(did);
    homeSpaces = spaces.map((s) => s.tail);
    memo.joinedSpaces.set(joinedKey(did), homeSpaces);
  }

  for (const homeSpace of homeSpaces) {
    // Active federation from origin -> this home space?
    const fk = fedKey(originSpace, homeSpace);
    let active: boolean;
    if (memo.activeFederation.has(fk)) {
      active = memo.activeFederation.get(fk)!;
    } else {
      const fed = await globalDb
        .query(
          "select 1 as n from space_federations where space_id = ? and federating_space_did = ? and status = 'active'",
        )
        .get<{ n: number }>(originSpace, homeSpace);
      // `.get()` returns null when no row matches (not undefined).
      active = fed != null;
      memo.activeFederation.set(fk, active);
    }
    if (!active) continue;

    // Origin grant on the (parent) channel?
    const ok = originKey(originSpace, homeSpace, grantRoom);
    let origin: Permission | null;
    if (memo.originGrant.has(ok)) {
      origin = memo.originGrant.get(ok)!;
    } else {
      const o = await globalDb
        .query(
          "select permission from federation_room_permissions where space_id = ? and federating_space_did = ? and room_id = ?",
        )
        .get<{ permission: Permission }>(originSpace, homeSpace, grantRoom);
      origin = o?.permission ?? null;
      memo.originGrant.set(ok, origin);
    }
    if (origin === null) continue;

    // Resolve the caller's standing in the receiving space B once. Used for
    // the B-admin override below, and to deny access to B-banned members
    // (a banned B member must not keep reading/writing a federated channel
    // through a stale receiver grant).
    let bAccess: Awaited<ReturnType<typeof spaceAccess>> | null = null;
    if (opts.spaceDbResolver) {
      const bDb = opts.spaceDbResolver(homeSpace);
      bAccess = await spaceAccess(bDb, homeSpace, did, opts.accessMemo);
    }

    // B admin override: admins of the receiving space get origin-level access.
    if (bAccess?.isAdmin) {
      return {
        canRead: true,
        canWrite: origin === "readwrite",
        homeSpaceDid: homeSpace,
      };
    }

    // A non-admin B member who is banned in B gets no federated access.
    if (bAccess?.isBanned) continue;

    // Receiver grant for a non-admin B member.
    const receiver = await resolveReceiverGrant(
      globalDb,
      opts.spaceDbResolver,
      originSpace,
      homeSpace,
      grantRoom,
      did,
    );
    if (receiver === null) continue; // no receiver grant -> no access

    const effective = minPermission(origin, receiver);
    return {
      canRead: true,
      canWrite: effective === "readwrite",
      homeSpaceDid: homeSpace,
    };
  }

  return null;
}

/**
 * Resolve the most permissive receiver grant a B member holds on a channel:
 * the members-wide grant (kind='members', grantee = B's space DID) as the
 * base, a direct user grant for their DID, plus any role grants for roles
 * they hold in B. Returns null when there is no matching grant.
 */
async function resolveReceiverGrant(
  globalDb: DbLike,
  spaceDbResolver: ((spaceDid: string) => DbLike) | undefined,
  originSpace: string,
  homeSpace: string,
  roomId: string,
  did: string,
): Promise<Permission | null> {
  let best: Permission | null = null;

  // Members-wide grant: one row per (origin, B, room) with kind='members'
  // and grantee = B's space DID; every member of B picks it up.
  const membersGrant = await globalDb
    .query(
      "select permission from federation_receiver_permissions where space_id = ? and federating_space_did = ? and room_id = ? and grantee = ? and kind = 'members'",
    )
    .get<{ permission: Permission }>(originSpace, homeSpace, roomId, homeSpace);
  if (membersGrant) best = membersGrant.permission;

  const userGrant = await globalDb
    .query(
      "select permission from federation_receiver_permissions where space_id = ? and federating_space_did = ? and room_id = ? and grantee = ? and kind = 'user'",
    )
    .get<{ permission: Permission }>(originSpace, homeSpace, roomId, did);
  if (userGrant) best = maxPermission(best, userGrant.permission);

  if (spaceDbResolver) {
    const bDb = spaceDbResolver(homeSpace);
    const roleIds = await bDb
      .query("select role_id from member_roles where user_id = ? and stream_id = ?")
      .all<{ role_id: string }>(did, homeSpace);
    for (const r of roleIds) {
      const g = await globalDb
        .query(
          "select permission from federation_receiver_permissions where space_id = ? and federating_space_did = ? and room_id = ? and grantee = ? and kind = 'role'",
        )
        .get<{ permission: Permission }>(originSpace, homeSpace, roomId, r.role_id);
      if (g) best = maxPermission(best, g.permission);
    }
  }

  return best;
}
