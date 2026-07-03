/**
 * Authorization unit for the appserver.
 *
 * Self-contained, decision-only. Pure functions of `(db, ...ids)` returning
 * decision objects. Throws nothing, performs no I/O beyond the passed
 * `Database` handle, and has no awareness of XRPC/HTTP semantics.
 *
 * Coupling rules — see `docs/plans/.llm.2026-05-08-remaining-xrpc-queries.md`:
 *   - No imports from `src/xrpc/`, `src/handlers/`, `src/hydration/`.
 *   - No `XrpcError`, no HTTP status codes, no logging.
 *   - HTTP translation lives in `src/xrpc/authGuards.ts` (a separate adapter).
 *
 * The unit is the surface that a model-based test harness drives directly.
 */

import type { DbLike } from "../db/types.ts";

export type DefaultAccess = "readwrite" | "read" | "none";

export interface SpaceAccess {
  isMember: boolean;
  isAdmin: boolean;
  isBanned: boolean;
}

export interface RoomAccess {
  /** True iff the room entity exists in the materialised view. */
  exists: boolean;
  /** True iff the caller can read the room (admin OR default_access≠none OR role grant). */
  canRead: boolean;
  /** True iff the caller can write to the room (admin OR default_access=readwrite OR role 'readwrite'). */
  canWrite: boolean;
  /** Caller's admin status on the parent space. */
  isAdmin: boolean;
  /** Effective default_access (for threads: inherited from canonical parent channel). */
  defaultAccess: DefaultAccess;
  /** Parent space DID (entities.stream_id). null when the room doesn't exist. */
  spaceId: string | null;
  /** Canonical parent channel ID for threads, null for channels themselves. */
  parentChannelId: string | null;
  /** Caller is banned from the room's parent space. */
  isBanned: boolean;
}


// ── Membership / admin / ban ──────────────────────────────────────────────

export async function isMember(db: DbLike, spaceId: string, did: string | null): Promise<boolean> {
  if (did === null) return false;
  const row = await db.query("select 1 as n from edges where head = ? and tail = ? and label = 'member' limit 1").get<{ n: number }>([spaceId, did]);
  return row !== null;
}

export async function isAdmin(db: DbLike, spaceId: string, did: string | null): Promise<boolean> {
  if (did === null) return false;
  const row = await db.query("select 1 as n from edges where head = ? and tail = ? and label = 'admin' limit 1").get<{ n: number }>([spaceId, did]);
  return row !== null;
}

export async function isBanned(db: DbLike, spaceId: string, did: string | null): Promise<boolean> {
  if (did === null) return false;
  const row = await db.query("select 1 as n from comp_bans where entity = ? and user_did = ? limit 1").get<{ n: number }>([spaceId, did]);
  return row !== null;
}

export async function spaceAccess(
  db: DbLike,
  spaceId: string,
  did: string | null,
): Promise<SpaceAccess> {
  return {
    isMember: await isMember(db, spaceId, did),
    isAdmin: await isAdmin(db, spaceId, did),
    isBanned: await isBanned(db, spaceId, did),
  };
}

/**
 * Whether the space allows public (no-invite) joining. NULL in the DB means
 * unset; per schema docs that defaults to "open" (true).
 */
export async function allowsPublicJoin(db: DbLike, spaceId: string): Promise<boolean> {
  const row = await db.query("select coalesce(allow_public_join, 1) as v from comp_space where entity = ?").get<{ v: number }>([spaceId]);
  return row === null ? true : row.v === 1;
}

// ── Room access ───────────────────────────────────────────────────────────

interface RoomRow {
  spaceId: string | null;
  defaultAccess: DefaultAccess;
}

/**
 * Resolve the room's parent space (entities.stream_id) and effective default_access.
 *
 * For threads (and any other room without its own default_access value), follow
 * the canonical `link` edge backward to the parent channel and inherit from there.
 *
 * Returns the resolved row plus the canonical parent channel ID (null when the
 * room is a channel itself, or has no canonical parent link).
 */
async function resolveRoom(
  db: DbLike,
  roomId: string,
): Promise<{ row: RoomRow | null; parentChannelId: string | null }> {
  const row = await db.query(
    `select e.stream_id as space_id, cr.default_access as default_access
       from entities e
       left join comp_room cr on cr.entity = e.id
      where e.id = ?`,
  ).get<{ space_id: string | null; default_access: string | null }>([roomId]);

  if (row === null) return { row: null, parentChannelId: null };

  // Find canonical parent channel (if this room is a thread linked from a channel).
  const parent = await db.query(
    `select head from edges
      where tail = ? and label = 'link'
        and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
      limit 1`,
  ).get<{ head: string }>([roomId]);

  const parentChannelId = parent?.head ?? null;

  // When a canonical parent channel exists, the thread's effective
  // default_access is the more restrictive of the parent's and the
  // thread's own (if set). A thread cannot grant more access than its
  // parent channel allows.
  if (parentChannelId !== null) {
    const parentRow = await db.query("select default_access from comp_room where entity = ?").get<{ default_access: string | null }>([parentChannelId]);
    const parentAccess = normalizeDefaultAccess(parentRow?.default_access);
    const ownAccess = normalizeDefaultAccess(row.default_access);
    return {
      row: {
        spaceId: row.space_id,
        defaultAccess: minAccess(parentAccess, ownAccess),
      },
      parentChannelId,
    };
  }

  return {
    row: {
      spaceId: row.space_id,
      defaultAccess: normalizeDefaultAccess(row.default_access),
    },
    parentChannelId,
  };
}

/**
 * Return the more restrictive of two DefaultAccess values.
 * Ordering: none (most restrictive) < read < readwrite (least restrictive).
 */
function minAccess(a: DefaultAccess, b: DefaultAccess): DefaultAccess {
  const level: Record<DefaultAccess, number> = {
    none: 0,
    read: 1,
    readwrite: 2,
  };
  return level[a] <= level[b] ? a : b;
}

function normalizeDefaultAccess(raw: string | null | undefined): DefaultAccess {
  if (raw === "read" || raw === "none" || raw === "readwrite") return raw;
  return "readwrite";
}

/**
 * Does this caller hold a role that grants the given permission on this room?
 *
 * Roles are space-scoped (`roles.stream_id = spaceId`), assigned via
 * `member_roles`, and grant per-room permissions via `role_rooms`. Soft-deleted
 * roles (`roles.deleted = 1`) are ignored.
 */
async function roleGrant(
  db: DbLike,
  spaceId: string,
  roomId: string,
  did: string | null,
): Promise<{ canRead: boolean; canWrite: boolean }> {
  if (did === null) return { canRead: false, canWrite: false };
  const row = await db.query(
    `select
       max(case when rr.permission in ('read', 'readwrite') then 1 else 0 end) as has_read,
       max(case when rr.permission = 'readwrite' then 1 else 0 end) as has_write
       from member_roles mr
       join role_rooms rr on rr.role_id = mr.role_id
       join roles ro on ro.id = mr.role_id
      where mr.user_id = ?1
        and rr.room_id = ?2
        and ro.stream_id = ?3
        and ro.deleted = 0`,
  ).get<{ has_read: number; has_write: number }>([did, roomId, spaceId]);

  return {
    canRead: !!row?.has_read,
    canWrite: !!row?.has_write,
  };
}

export async function roomAccess(
  db: DbLike,
  roomId: string,
  did: string | null,
): Promise<RoomAccess> {
  const { row, parentChannelId } = await resolveRoom(db, roomId);

  if (row === null || row.spaceId === null) {
    return {
      exists: false,
      canRead: false,
      canWrite: false,
      isAdmin: false,
      defaultAccess: "readwrite",
      spaceId: null,
      parentChannelId: null,
      isBanned: false,
    };
  }

  const spaceId = row.spaceId;
  const banned = await isBanned(db, spaceId, did);
  const admin = await isAdmin(db, spaceId, did);

  // Banned users get nothing, even admins. (Bans are an explicit deny.)
  if (banned) {
    return {
      exists: true,
      canRead: false,
      canWrite: false,
      isAdmin: false,
      defaultAccess: row.defaultAccess,
      spaceId,
      parentChannelId,
      isBanned: true,
    };
  }

  // Admin override.
  if (admin) {
    return {
      exists: true,
      canRead: true,
      canWrite: true,
      isAdmin: true,
      defaultAccess: row.defaultAccess,
      spaceId,
      parentChannelId,
      isBanned: false,
    };
  }

  // Role grants on the effective room (for threads, perms attach to the
  // parent channel — match the SDK's effective-channel rule).
  const permRoom = parentChannelId ?? roomId;
  const grant = await roleGrant(db, spaceId, permRoom, did);

  // Union with default_access. `none` blocks unless a role grants read.
  const defaultGrantsRead = row.defaultAccess !== "none";
  const defaultGrantsWrite = row.defaultAccess === "readwrite";

  // Space-level gates: invite-only spaces require membership for read; all
  // spaces require membership for write (non-admins). See specCanRead /
  // specCanWrite in specs/auth.qnt.
  const member = await isMember(db, spaceId, did);
  const publicJoin = await allowsPublicJoin(db, spaceId);
  const passesReadGate = publicJoin || member;

  return {
    exists: true,
    canRead: passesReadGate && (defaultGrantsRead || grant.canRead),
    canWrite: member && (defaultGrantsWrite || grant.canWrite),
    isAdmin: false,
    defaultAccess: row.defaultAccess,
    spaceId,
    parentChannelId,
    isBanned: false,
  };
}
