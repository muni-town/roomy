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

import type { Database, Statement } from "bun:sqlite";

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

// ── Prepared statement cache ─────────────────────────────────────────────
// bun:sqlite's .query() prepares SQL on every call. Caching Statement objects
// avoids redundant compilation, which matters when the auth unit runs 8+
// queries per sendEvent request.

interface AuthStmts {
  isMember: Statement<{ n: number }, [string, string]>;
  isAdmin: Statement<{ n: number }, [string, string]>;
  isBanned: Statement<{ n: number }, [string, string]>;
  allowsPublicJoin: Statement<{ v: number }, [string]>;
  resolveRoom: Statement<{ space_id: string | null; default_access: string | null }, [string]>;
  canonicalParent: Statement<{ head: string }, [string]>;
  parentDefaultAccess: Statement<{ default_access: string | null }, [string]>;
  roleGrant: Statement<{ has_read: number; has_write: number }, [string, string, string]>;
}

const stmtCache = new WeakMap<Database, AuthStmts>();

function stmts(db: Database): AuthStmts {
  let cached = stmtCache.get(db);
  if (cached) return cached;

  cached = {
    isMember: db.prepare<
      { n: number },
      [string, string]
    >("select 1 as n from edges where head = ? and tail = ? and label = 'member' limit 1"),

    isAdmin: db.prepare<
      { n: number },
      [string, string]
    >("select 1 as n from edges where head = ? and tail = ? and label = 'admin' limit 1"),

    isBanned: db.prepare<
      { n: number },
      [string, string]
    >("select 1 as n from comp_bans where entity = ? and user_did = ? limit 1"),

    allowsPublicJoin: db.prepare<
      { v: number },
      [string]
    >("select coalesce(allow_public_join, 1) as v from comp_space where entity = ?"),

    resolveRoom: db.prepare<
      { space_id: string | null; default_access: string | null },
      [string]
    >(
      `select e.stream_id as space_id, cr.default_access as default_access
         from entities e
         left join comp_room cr on cr.entity = e.id
        where e.id = ?`,
    ),

    canonicalParent: db.prepare<
      { head: string },
      [string]
    >(
      `select head from edges
        where tail = ? and label = 'link'
          and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
        limit 1`,
    ),

    parentDefaultAccess: db.prepare<
      { default_access: string | null },
      [string]
    >("select default_access from comp_room where entity = ?"),

    roleGrant: db.prepare<
      { has_read: number; has_write: number },
      [string, string, string]
    >(
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
    ),
  };

  stmtCache.set(db, cached);
  return cached;
}

// ── Membership / admin / ban ──────────────────────────────────────────────

export function isMember(db: Database, spaceId: string, did: string): boolean {
  return stmts(db).isMember.get(spaceId, did) !== null;
}

export function isAdmin(db: Database, spaceId: string, did: string): boolean {
  return stmts(db).isAdmin.get(spaceId, did) !== null;
}

export function isBanned(db: Database, spaceId: string, did: string): boolean {
  return stmts(db).isBanned.get(spaceId, did) !== null;
}

export function spaceAccess(
  db: Database,
  spaceId: string,
  did: string,
): SpaceAccess {
  return {
    isMember: isMember(db, spaceId, did),
    isAdmin: isAdmin(db, spaceId, did),
    isBanned: isBanned(db, spaceId, did),
  };
}

/**
 * Whether the space allows public (no-invite) joining. NULL in the DB means
 * unset; per schema docs that defaults to "open" (true).
 */
function allowsPublicJoin(db: Database, spaceId: string): boolean {
  const row = stmts(db).allowsPublicJoin.get(spaceId);
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
function resolveRoom(
  db: Database,
  roomId: string,
): { row: RoomRow | null; parentChannelId: string | null } {
  const s = stmts(db);
  const row = s.resolveRoom.get(roomId);

  if (row === null) return { row: null, parentChannelId: null };

  // Find canonical parent channel (if this room is a thread linked from a channel).
  const parent = s.canonicalParent.get(roomId);

  const parentChannelId = parent?.head ?? null;

  // If this room has no default_access of its own, inherit from canonical parent.
  if (row.default_access === null && parentChannelId !== null) {
    const parentRow = s.parentDefaultAccess.get(parentChannelId);
    return {
      row: {
        spaceId: row.space_id,
        defaultAccess: normalizeDefaultAccess(parentRow?.default_access),
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
function roleGrant(
  db: Database,
  spaceId: string,
  roomId: string,
  did: string,
): { canRead: boolean; canWrite: boolean } {
  const row = stmts(db).roleGrant.get(did, roomId, spaceId);

  return {
    canRead: !!row?.has_read,
    canWrite: !!row?.has_write,
  };
}

export function roomAccess(
  db: Database,
  roomId: string,
  did: string,
): RoomAccess {
  const { row, parentChannelId } = resolveRoom(db, roomId);

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
  const banned = isBanned(db, spaceId, did);
  const admin = isAdmin(db, spaceId, did);

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
  const grant = roleGrant(db, spaceId, permRoom, did);

  // Union with default_access. `none` blocks unless a role grants read.
  const defaultGrantsRead = row.defaultAccess !== "none";
  const defaultGrantsWrite = row.defaultAccess === "readwrite";

  // Space-level gates: invite-only spaces require membership for read; all
  // spaces require membership for write (non-admins). See specCanRead /
  // specCanWrite in specs/auth.qnt.
  const member = isMember(db, spaceId, did);
  const publicJoin = allowsPublicJoin(db, spaceId);
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
