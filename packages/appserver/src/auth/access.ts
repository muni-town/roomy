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
  /**
   * Set only when the caller's access came through a federation (a channel of
   * the room's origin space federated into a space the caller belongs to).
   * The caller's home space through which the grant flowed — used to target
   * unread/read invalidation at the receiving space's sidebar rather than the
   * origin's. Absent for native access.
   */
  federatedHomeSpaceId?: string | null;
}

// ── Per-request memo ──────────────────────────────────────────────────────

/**
 * Per-request cache for access decisions.
 *
 * A single XRPC handler invocation often checks the same `(spaceId, did)`
 * membership/admin/ban flags and the same `roomId` access decision many
 * times — e.g. `space.roomy.room.getMetadata` calls `roomAccess` for each
 * recent thread, and each call re-queries `isMember`/`isAdmin`/`isBanned`
 * for the *same* parent space. Without a memo, that is ~6 SQL statements
 * per thread, most of them redundant.
 *
 * The memo is keyed by `(did, spaceId)` for space-scoped booleans and by
 * `(did, roomId)` for full room decisions. It is intentionally per-request
 * (not process-global): access state can change between requests via
 * events, and a stale cache would be a security bug. Callers create one
 * with `createAccessMemo()` at the top of a handler and pass it through to
 * every access call in that request.
 *
 * All access functions accept an optional `memo` final argument. When
 * omitted, a transient memo is constructed for that call only — so nested
 * calls within a single top-level call still deduplicate against each
 * other, but unrelated callers do not share state. Threading the *same*
 * memo across a whole handler is what collapses the N×SQL fan-out.
 */
export interface AccessMemo {
  /** Cached `SpaceAccess` keyed by `${did}\0${spaceId}` (did=null → "\0spaceId"). */
  readonly space: Map<string, SpaceAccess>;
  /** Cached `allowsPublicJoin` keyed by spaceId. */
  readonly publicJoin: Map<string, boolean>;
  /** Cached `RoomAccess` keyed by `${did}\0${roomId}`. */
  readonly room: Map<string, RoomAccess>;
  /** In-flight `roomAccess` promises to coalesce concurrent calls for the same room. */
  readonly roomInflight: Map<string, Promise<RoomAccess>>;
}

/** Create a fresh per-request access memo. */
export function createAccessMemo(): AccessMemo {
  return {
    space: new Map(),
    publicJoin: new Map(),
    room: new Map(),
    roomInflight: new Map(),
  };
}

function spaceKey(did: string | null, spaceId: string): string {
  return `${did ?? ""}\0${spaceId}`;
}

function roomKey(did: string | null, roomId: string): string {
  return `${did ?? ""}\0${roomId}`;
}

// ── Membership / admin / ban ──────────────────────────────────────────────

export async function isMember(
  db: DbLike,
  spaceId: string,
  did: string | null,
  memo?: AccessMemo,
): Promise<boolean> {
  return (await spaceAccessCached(db, spaceId, did, memo)).isMember;
}

export async function isAdmin(
  db: DbLike,
  spaceId: string,
  did: string | null,
  memo?: AccessMemo,
): Promise<boolean> {
  return (await spaceAccessCached(db, spaceId, did, memo)).isAdmin;
}

export async function isBanned(
  db: DbLike,
  spaceId: string,
  did: string | null,
  memo?: AccessMemo,
): Promise<boolean> {
  return (await spaceAccessCached(db, spaceId, did, memo)).isBanned;
}

/**
 * Resolve `SpaceAccess` for `(spaceId, did)`, memoised per request.
 *
 * `isMember`/`isAdmin`/`isBanned` all derive from this, so a single
 * `spaceAccess` call (or any combination of the three predicates) costs
 * exactly three SQL statements per `(spaceId, did)` per memo lifetime —
 * not three per predicate per call.
 */
export async function spaceAccess(
  db: DbLike,
  spaceId: string,
  did: string | null,
  memo?: AccessMemo,
): Promise<SpaceAccess> {
  return spaceAccessCached(db, spaceId, did, memo);
}

async function spaceAccessCached(
  db: DbLike,
  spaceId: string,
  did: string | null,
  memo?: AccessMemo,
): Promise<SpaceAccess> {
  const m = memo ?? createAccessMemo();
  const key = spaceKey(did, spaceId);
  const hit = m.space.get(key);
  if (hit) return hit;

  const result: SpaceAccess = {
    isMember: await queryIsMember(db, spaceId, did),
    isAdmin: await queryIsAdmin(db, spaceId, did),
    isBanned: await queryIsBanned(db, spaceId, did),
  };
  m.space.set(key, result);
  return result;
}

async function queryIsMember(db: DbLike, spaceId: string, did: string | null): Promise<boolean> {
  if (did === null) return false;
  const row = await db.query("select 1 as n from edges where head = ? and tail = ? and label = 'member' limit 1").get<{ n: number }>([spaceId, did]);
  return row !== null;
}

async function queryIsAdmin(db: DbLike, spaceId: string, did: string | null): Promise<boolean> {
  if (did === null) return false;
  const row = await db.query("select 1 as n from edges where head = ? and tail = ? and label = 'admin' limit 1").get<{ n: number }>([spaceId, did]);
  return row !== null;
}

async function queryIsBanned(db: DbLike, spaceId: string, did: string | null): Promise<boolean> {
  if (did === null) return false;
  const row = await db.query("select 1 as n from comp_bans where entity = ? and user_did = ? limit 1").get<{ n: number }>([spaceId, did]);
  return row !== null;
}

/**
 * Whether the space allows public (no-invite) joining. NULL in the DB means
 * unset; per schema docs that defaults to "open" (true).
 */
export async function allowsPublicJoin(
  db: DbLike,
  spaceId: string,
  memo?: AccessMemo,
): Promise<boolean> {
  const m = memo ?? createAccessMemo();
  const hit = m.publicJoin.get(spaceId);
  if (hit !== undefined) return hit;
  const row = await db.query("select coalesce(allow_public_join, 1) as v from comp_space where entity = ?").get<{ v: number }>(spaceId);
  const result = row === null ? true : row.v === 1;
  m.publicJoin.set(spaceId, result);
  return result;
}

// ── Room access ───────────────────────────────────────────────────────────

export interface RoomRow {
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
export async function resolveRoom(
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
  memo?: AccessMemo,
): Promise<RoomAccess> {
  const m = memo ?? createAccessMemo();
  const key = roomKey(did, roomId);
  const hit = m.room.get(key);
  if (hit) return hit;

  // Coalesce concurrent calls for the same (did, roomId). Within a single
  // handler, `Promise.all(threads.map(t => roomAccess(...)))` can issue
  // duplicate checks for the same thread id (e.g. a thread appearing twice
  // in an activity list) — without this, both would run the full SQL chain.
  const inflight = m.roomInflight.get(key);
  if (inflight) return inflight;

  const promise = computeRoomAccess(db, roomId, did, m).then((result) => {
    m.room.set(key, result);
    m.roomInflight.delete(key);
    return result;
  });
  m.roomInflight.set(key, promise);
  return promise;
}

async function computeRoomAccess(
  db: DbLike,
  roomId: string,
  did: string | null,
  memo: AccessMemo,
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
  // Membership/admin/ban for the parent space — memoised across all rooms
  // in this space that this request touches.
  const space = await spaceAccessCached(db, spaceId, did, memo);

  // Banned users get nothing, even admins. (Bans are an explicit deny.)
  if (space.isBanned) {
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
  if (space.isAdmin) {
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
  const publicJoin = await allowsPublicJoin(db, spaceId, memo);
  const passesReadGate = publicJoin || space.isMember;

  return {
    exists: true,
    canRead: passesReadGate && (defaultGrantsRead || grant.canRead),
    canWrite: space.isMember && (defaultGrantsWrite || grant.canWrite),
    isAdmin: false,
    defaultAccess: row.defaultAccess,
    spaceId,
    parentChannelId,
    isBanned: false,
  };
}

/**
 * Resolve `RoomAccess` for many rooms in one batched pass.
 *
 * The per-room `roomAccess` path issues ~3–4 SQL round-trips per room
 * (resolveRoom: entity+default_access, parent link, parent default_access for
 * threads; plus roleGrant). Handlers that check every room in a space
 * (`getThreads` up to 100 rooms, `getMetadata`'s sidebar) therefore fan out
 * hundreds of round-trips to the per-space DB worker — a pool-saturation
 * source under load.
 *
 * This batches the same lookups into ~4 queries total (entity+default_access,
 * parent links, parent default_access, role grants), then assembles each
 * `RoomAccess` in JS with the exact same decision logic as `computeRoomAccess`
 * (banned deny, admin override, default_access ∪ role grant, public-join gate).
 * Results are written into the shared memo so later single-room `roomAccess`
 * calls hit the cache.
 *
 * Must stay in parity with `computeRoomAccess` — the MBT spec-oracle tests
 * drive both against the same model.
 */
export async function roomAccessMany(
  db: DbLike,
  roomIds: string[],
  did: string | null,
  memo?: AccessMemo,
): Promise<Map<string, RoomAccess>> {
  const m = memo ?? createAccessMemo();
  const result = new Map<string, RoomAccess>();

  // Dedupe and skip rooms already resolved in this request.
  const pending: string[] = [];
  for (const roomId of roomIds) {
    const key = roomKey(did, roomId);
    const hit = m.room.get(key);
    if (hit) {
      result.set(roomId, hit);
    } else {
      pending.push(roomId);
    }
  }
  if (pending.length === 0) return result;

  const ph = pending.map(() => "?").join(",");

  // 1. entity + default_access for all pending rooms.
  const roomRows = await db
    .query(
      `select e.id as id, e.stream_id as space_id, cr.default_access as default_access
         from entities e
         left join comp_room cr on cr.entity = e.id
        where e.id in (${ph})`,
    )
    .all<{ id: string; space_id: string | null; default_access: string | null }>(...pending);
  const roomById = new Map(roomRows.map((r) => [r.id, r]));

  // 2. canonical parent links for all pending rooms.
  const parentRows = await db
    .query(
      `select tail, head from edges
        where tail in (${ph})
          and label = 'link'
          and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1`,
    )
    .all<{ tail: string; head: string }>(...pending);
  const parentByRoom = new Map(parentRows.map((r) => [r.tail, r.head]));

  // 3. parent-channel default_access for the distinct parent ids.
  const parentIds = [...new Set(parentByRoom.values())];
  const parentAccess = new Map<string, DefaultAccess>();
  if (parentIds.length > 0) {
    const pph = parentIds.map(() => "?").join(",");
    const pRows = await db
      .query(
        `select entity, default_access from comp_room where entity in (${pph})`,
      )
      .all<{ entity: string; default_access: string | null }>(...parentIds);
    for (const r of pRows) parentAccess.set(r.entity, normalizeDefaultAccess(r.default_access));
  }

  // Space-level membership/admin/ban + public-join gate, once per distinct
  // space (memoised across the whole request).
  const spaceIds = [...new Set(roomRows.map((r) => r.space_id).filter((s): s is string => s !== null))];
  const spaceBySpace = new Map<string, SpaceAccess>();
  const publicJoinBySpace = new Map<string, boolean>();
  for (const sid of spaceIds) {
    spaceBySpace.set(sid, await spaceAccessCached(db, sid, did, m));
    publicJoinBySpace.set(sid, await allowsPublicJoin(db, sid, m));
  }

  // 4. role grants for the distinct effective rooms (parentChannelId ?? roomId).
  // Roles are space-scoped, so join entities to scope each grant by its own
  // room's space — correct even if a batch spans multiple spaces.
  const permRooms = [...new Set(pending.map((roomId) => parentByRoom.get(roomId) ?? roomId))];
  const grantByRoom = new Map<string, { canRead: boolean; canWrite: boolean }>();
  if (did !== null && permRooms.length > 0) {
    const rph = permRooms.map(() => "?").join(",");
    const grantRows = await db
      .query(
        `select rr.room_id as room_id,
                max(case when rr.permission in ('read', 'readwrite') then 1 else 0 end) as has_read,
                max(case when rr.permission = 'readwrite' then 1 else 0 end) as has_write
           from member_roles mr
           join role_rooms rr on rr.role_id = mr.role_id
           join roles ro on ro.id = mr.role_id
           join entities e on e.id = rr.room_id
          where mr.user_id = ?1
            and rr.room_id in (${rph})
            and ro.stream_id = e.stream_id
            and ro.deleted = 0
          group by rr.room_id`,
      )
      .all<{ room_id: string; has_read: number; has_write: number }>(did, ...permRooms);
    for (const r of grantRows) {
      grantByRoom.set(r.room_id, { canRead: !!r.has_read, canWrite: !!r.has_write });
    }
  }

  for (const roomId of pending) {
    const row = roomById.get(roomId);
    const parentChannelId = parentByRoom.get(roomId) ?? null;

    // Room doesn't exist in the materialised view.
    if (!row || row.space_id === null) {
      const acc: RoomAccess = {
        exists: false,
        canRead: false,
        canWrite: false,
        isAdmin: false,
        defaultAccess: "readwrite",
        spaceId: null,
        parentChannelId: null,
        isBanned: false,
      };
      result.set(roomId, acc);
      m.room.set(roomKey(did, roomId), acc);
      continue;
    }

    // Effective default_access: threads inherit the more restrictive of the
    // parent channel's and their own.
    const ownAccess = normalizeDefaultAccess(row.default_access);
    const effectiveAccess = parentChannelId !== null
      ? minAccess(parentAccess.get(parentChannelId) ?? "readwrite", ownAccess)
      : ownAccess;

    const spaceId = row.space_id;
    const space = spaceBySpace.get(spaceId)!;

    if (space.isBanned) {
      const acc: RoomAccess = {
        exists: true,
        canRead: false,
        canWrite: false,
        isAdmin: false,
        defaultAccess: effectiveAccess,
        spaceId,
        parentChannelId,
        isBanned: true,
      };
      result.set(roomId, acc);
      m.room.set(roomKey(did, roomId), acc);
      continue;
    }

    if (space.isAdmin) {
      const acc: RoomAccess = {
        exists: true,
        canRead: true,
        canWrite: true,
        isAdmin: true,
        defaultAccess: effectiveAccess,
        spaceId,
        parentChannelId,
        isBanned: false,
      };
      result.set(roomId, acc);
      m.room.set(roomKey(did, roomId), acc);
      continue;
    }

    const permRoom = parentChannelId ?? roomId;
    const grant = grantByRoom.get(permRoom) ?? { canRead: false, canWrite: false };
    const defaultGrantsRead = effectiveAccess !== "none";
    const defaultGrantsWrite = effectiveAccess === "readwrite";
    const publicJoin = publicJoinBySpace.get(spaceId) ?? false;
    const passesReadGate = publicJoin || space.isMember;

    const acc: RoomAccess = {
      exists: true,
      canRead: passesReadGate && (defaultGrantsRead || grant.canRead),
      canWrite: space.isMember && (defaultGrantsWrite || grant.canWrite),
      isAdmin: false,
      defaultAccess: effectiveAccess,
      spaceId,
      parentChannelId,
      isBanned: false,
    };
    result.set(roomId, acc);
    m.room.set(roomKey(did, roomId), acc);
  }

  return result;
}