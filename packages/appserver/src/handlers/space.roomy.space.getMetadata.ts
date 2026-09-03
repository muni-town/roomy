/**
 * XRPC: space.roomy.space.getMetadata (query).
 *
 * Returns space metadata + the complete sidebar tree filtered by the caller's
 * read access. Channels the caller cannot read are omitted from each category
 * (and from `orphans`). Stage-1: unreadCount/lastRead are 0/null.
 */

import { createAccessMemo, roomAccessMany, spaceAccess } from "../auth/access.ts";
import { createFederationMemo, federatedRoomAccess } from "../auth/federation.ts";
import { openReadStateDb, openSpaceDb, openGlobalDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { getReadPositions, getSpaceSidebarData, ensureReadPositions } from "../queries/readPositions.ts";
import { queryActiveThreads, resolveThreadsByIds } from "../queries/userActiveThreads.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ActiveSidebarThread {
  id: string;
  name?: string;
  activity: {
    latestTimestamp: string | null;
    latestMembers: Array<{ did: string; name: string | null; avatar: string | null }>;
  };
  canRead: boolean;
  canWrite: boolean;
  unreadCount: number;
  lastRead: string | null;
}

interface SidebarChannel {
  id: string;
  name?: string;
  defaultAccess: "readwrite" | "read" | "none";
  canRead: boolean;
  canWrite: boolean;
  unreadCount: number;
  lastRead?: string;
  activeThreads?: ActiveSidebarThread[];
  /** Set for channels federated INTO this space from another (origin) space. */
  federated?: {
    originSpaceId: string;
    originSpaceName?: string;
    originSpaceAvatar?: string;
    permission: "read" | "readwrite";
  };
}

interface SidebarCategory {
  id?: string; // absent for v0 (legacy categories with no stable id)
  name: string;
  position: number;
  channels: SidebarChannel[];
}

interface DeletedRoom {
  id: string;
  name?: string;
}

interface GetMetadataResult {
  name?: string;
  avatar?: string;
  description?: string;
  handle?: string;
  joinPolicy: { allowPublicJoin: boolean; allowMemberInvites: boolean };
  isMember: boolean;
  isAdmin: boolean;
  /** Number of channels with unread messages (sidebar-visible rooms only). */
  unreadRoomCount: number;
  /** Number of engaged threads with unread messages. */
  unreadThreadCount: number;
  sidebar: { categories: SidebarCategory[]; orphans: SidebarChannel[] };
  deletedRooms?: DeletedRoom[];
}

interface SidebarConfig {
  categories: Array<{
    id?: string;
    name: string;
    children: string[];
  }>;
}

export const getMetadataHandler: QueryHandler<
  QueryParams,
  GetMetadataResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const spaceId = requireString(params, "spaceId");

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openSpaceDb(spaceId);
  const mainDb = openReadStateDb();
  // Metadata (name, avatar, joinPolicy, isMember) is required to render the
  // join / accept-invite UI for spaces the caller is not yet a member of —
  // including invite-only spaces. We therefore don't require read membership
  // here: compute the access decision directly and only block banned callers.
  // The channel/thread sidebar below is still gated on membership, so
  // non-members receive an empty sidebar.
  //
  // The memo shares access decisions across every channel and active-thread
  // check below. Without it, `buildChannel` + the orphan loop + the
  // active-threads loop each call `roomAccess` per room, and each call
  // re-queries the same space-level membership/admin/ban flags (~5 queries
  // × ~N channels × ~3 passes). The memo collapses the space-level checks
  // to one set for the whole request and caches per-room decisions.
  const memo = createAccessMemo();
  // Per-request federation memo: collapses the N×SQL fan-out in the sidebar
  // loop below (every federated channel re-queries the same joined-spaces row
  // and the same per-space B access). See auth/federation.ts.
  const fedMemo = createFederationMemo();
  const access = await spaceAccess(db, spaceId, userDid, memo);
  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }


  const spaceRow = await db
    .query(
      `select
           ci.name as name,
           ci.avatar as avatar,
           ci.description as description,
           cs.handle as handle,
           cs.allow_public_join as allow_public_join,
           cs.allow_member_invites as allow_member_invites,
           cs.sidebar_config as sidebar_config
         from comp_space cs
         left join comp_info ci on ci.entity = cs.entity
        where cs.entity = ?`,
    )
    .get<{
      name: string | null;
      avatar: string | null;
      description: string | null;
      handle: string | null;
      allow_public_join: number | null;
      allow_member_invites: number | null;
      sidebar_config: string;
    }>(spaceId);

  if (spaceRow === null) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  let config: SidebarConfig;
  try {
    const parsed = JSON.parse(spaceRow.sidebar_config as string);
    config = {
      categories: Array.isArray(parsed?.categories) ? parsed.categories : [],
    };
  } catch {
    config = { categories: [] };
  }

  // Resolve every channel referenced in the config (and the full set of
  // channels in the space, so we can compute orphans).
  let categories: SidebarCategory[] = [];
  let orphans: SidebarChannel[] = [];

  // Sidebar requires a logged-in user — anonymous callers can't get member
  // or admin status, so isMember/isAdmin is always false for them.
  let unreadRoomCount = 0;
  let unreadThreadCount = 0;
  if (userDid !== null && (access.isMember || access.isAdmin)) {
    // Fetch the channel list, per-channel access, read positions, and unread
    // aggregates in ONE pass (rather than getSpaceUnreadStats fetching only
    // counts and this handler re-querying channels + read positions). Reuses
    // the shared access memo, so roomAccessMany work is not repeated.
    const data = await getSpaceSidebarData(mainDb, db, userDid, spaceId, memo, {
      includeReadPositions: true,
    });
    unreadRoomCount = data.unreadRoomCount;
    unreadThreadCount = data.unreadThreadCount;

    const channelById = new Map(data.channels.map((c) => [c.id, c]));
    const readPositions = data.readPositions;
    const channelAccess = data.access;

    const buildChannel = async (id: string): Promise<SidebarChannel | null> => {
      const row = channelById.get(id);
      if (!row) return null;
      const acc = channelAccess.get(id);
      if (!acc || !acc.canRead) return null;
      const pos = readPositions.get(id);
      return stripNulls({
        id: row.id,
        name: row.name,
        defaultAccess: acc.defaultAccess,
        canRead: acc.canRead,
        canWrite: acc.canWrite,
        unreadCount: pos?.unreadCount ?? 0,
        lastRead: pos?.lastRead ?? null,
      }) as SidebarChannel;
    };

    // ── Federated channels (Phase 2) ─────────────────────────────────
    // Channels of OTHER spaces (origins) that are federated INTO this space
    // with an origin grant. They appear in B's sidebar, decorated with their
    // origin space. B admins see all federated channels; B members see only
    // those they have a receiver grant for (see plan §5.5 / Phase 3).
    // Resolved BEFORE the category loop so federated channels referenced in
    // the sidebar config (placed there by drag-and-drop reorder) render in
    // their configured category/position instead of always falling back to
    // orphans.
    const federatedChannels = await buildFederatedSidebarChannels(spaceId, userDid, fedMemo, memo);
    const federatedById = new Map(federatedChannels.map((ch) => [ch.id, ch]));

    const referencedIds = new Set<string>();
    categories = await Promise.all(config.categories.map(async (cat, idx) => {
      const channels: SidebarChannel[] = [];
      for (const childId of cat.children ?? []) {
        referencedIds.add(childId);
        // Native channel → build from this space's DB; federated channel →
        // reuse the access-checked federated entry; unknown ID → drop.
        const ch = channelById.has(childId)
          ? await buildChannel(childId)
          : (federatedById.get(childId) ?? null);
        if (ch) channels.push(ch);
      }
      return stripNulls({
        id: cat.id ?? null,
        name: cat.name,
        position: idx,
        channels,
      }) as SidebarCategory;
    }));

    for (const row of data.channels) {
      if (referencedIds.has(row.id)) continue;
      const ch = await buildChannel(row.id);
      if (ch) orphans.push(ch);
    }

    // Federated channels not placed in any category stay in orphans (spaces
    // whose config predates federated placement keep seeing them).
    for (const ch of federatedChannels) {
      if (!referencedIds.has(ch.id)) orphans.push(ch);
    }

    // ── Active threads ────────────────────────────────────────────────
    // Fetch up to 8 threads the user has recently interacted with and
    // distribute them into their parent channels for the sidebar.
    const activeThreadEntries = await queryActiveThreads(mainDb, db, userDid, spaceId);

    if (activeThreadEntries.length > 0) {
      const threadIds = activeThreadEntries.map((t) => t.id);
      const threadMetaMap = await resolveThreadsByIds(db, threadIds);

      // Build active thread objects with access checks and read positions.
      const threadReadPositions = await getReadPositions(mainDb, userDid, threadIds);
      const threadAccess = await roomAccessMany(db, threadIds, userDid, memo);
      const activeThreadsByParent = new Map<string, ActiveSidebarThread[]>();

      for (const entry of activeThreadEntries) {
        const meta = threadMetaMap.get(entry.id);
        if (!meta) continue;

        const acc = threadAccess.get(entry.id);
        if (!acc || !acc.canRead) continue;

        const parentId = meta.canonicalParent;
        if (!parentId) continue; // orphan thread — not navigable

        const pos = threadReadPositions.get(entry.id);
        const threadItem: ActiveSidebarThread = {
          id: entry.id,
          name: meta.name ?? undefined,
          activity: {
            latestTimestamp: meta.latestTimestamp,
            latestMembers: meta.latestMembers,
          },
          canRead: acc.canRead,
          canWrite: acc.canWrite,
          unreadCount: pos?.unreadCount ?? 0,
          lastRead: pos?.lastRead ?? null,
        };

        const existing = activeThreadsByParent.get(parentId) ?? [];
        existing.push(threadItem);
        activeThreadsByParent.set(parentId, existing);
      }

      // Distribute threads into channels, sorted by last active (already
      // ordered from queryActiveThreads).
      if (activeThreadsByParent.size > 0) {
        const setActiveThreads = (ch: SidebarChannel) => {
          const threads = activeThreadsByParent.get(ch.id);
          if (threads && threads.length > 0) {
            ch.activeThreads = threads;
          }
        };

        for (const cat of categories) {
          for (const ch of cat.channels) {
            setActiveThreads(ch);
          }
        }
        for (const ch of orphans) {
          setActiveThreads(ch);
        }
      }
    }
  }

  // Deleted rooms — only fetched when explicitly requested
  let deletedRooms: DeletedRoom[] | undefined;
  if (params.includeDeleted === "true") {
    const deletedRows = await db
      .query(
        `select e.id as id, ci.name as name
           from entities e
           join comp_room cr on cr.entity = e.id
           left join comp_info ci on ci.entity = e.id
          where e.stream_id = ?
            and cr.label = 'space.roomy.channel'
            and cr.deleted = 1`,
      )
      .all<{ id: string; name: string | null }>(spaceId);
    deletedRooms = deletedRows.map((r) =>
      stripNulls({ id: r.id, name: r.name }) as DeletedRoom,
    );
  }

  return stripNulls({
    name: spaceRow.name,
    avatar: spaceRow.avatar,
    description: spaceRow.description,
    handle: spaceRow.handle,
    joinPolicy: {
      // null = unset → defaults per schema comments.
      allowPublicJoin: spaceRow.allow_public_join !== 0,
      allowMemberInvites: spaceRow.allow_member_invites === 1,
    },
    isMember: access.isMember,
    isAdmin: access.isAdmin,
    unreadRoomCount,
    unreadThreadCount,
    sidebar: { categories, orphans },
    ...(deletedRooms !== undefined ? { deletedRooms } : {}),
  }) as GetMetadataResult;
};

/**
 * Build the federated-channel entries for a space's sidebar: channels owned
 * by OTHER spaces (origins) that are federated into this space (B) with an
 * active origin grant. Each is decorated with its origin space + the grant
 * level. B admins see all federated channels; B members see only those they
 * have effective (receiver) access to.
 */
async function buildFederatedSidebarChannels(
  spaceId: string,
  userDid: string,
  fedMemo: ReturnType<typeof createFederationMemo>,
  memo: ReturnType<typeof createAccessMemo>,
): Promise<SidebarChannel[]> {
  const globalDb = openGlobalDb();
  const rows = await globalDb
    .query(
      `select frp.space_id as origin, frp.room_id as room_id, frp.permission as permission
         from federation_room_permissions frp
         join space_federations sf
           on sf.space_id = frp.space_id
          and sf.federating_space_did = frp.federating_space_did
        where frp.federating_space_did = ?
          and sf.status = 'active'`,
    )
    .all<{ origin: string; room_id: string; permission: string }>(spaceId);

  if (rows.length === 0) return [];

  // Group grants by origin space so we fetch channel metadata once per origin.
  const byOrigin = new Map<string, Array<{ roomId: string; permission: string }>>();
  for (const r of rows) {
    const list = byOrigin.get(r.origin) ?? [];
    list.push({ roomId: r.room_id, permission: r.permission });
    byOrigin.set(r.origin, list);
  }
  const out: SidebarChannel[] = [];
  // Federated rooms' read positions live in the shared read-state DB (the
  // origin's materializer bumps the caller's row, see applyBundle), so real
  // per-user unreadCounts are available — batch-fetch them once for all
  // federated rooms, like the native channel pass does.
  const mainDb = openReadStateDb();
  const fedGrantRoomIds = rows.map((r) => r.room_id);
  await ensureReadPositions(mainDb, userDid, fedGrantRoomIds);
  const fedPositions = await getReadPositions(mainDb, userDid, fedGrantRoomIds);
  for (const [origin, grants] of byOrigin) {
    const originDb = openSpaceDb(origin);
    // Origin space display info (name + avatar) for the sidebar decoration
    // and navbar. comp_info may be absent if the origin isn't materialised
    // locally or its DB is on a stale schema — a decoration lookup must
    // never take down the whole sidebar, so both stay optional.
    let originInfo: { name: string | null; avatar: string | null } | null = null;
    try {
      originInfo = await originDb
        .query("select name, avatar from comp_info where entity = ?")
        .get<{ name: string | null; avatar: string | null }>([origin]);
    } catch {
      originInfo = null;
    }
    const ids = grants.map((g) => g.roomId);
    const placeholders = ids.map(() => "?").join(", ");
    const infoRows = await originDb
      .query(
        `select e.id as id, ci.name as name
           from entities e
           left join comp_info ci on ci.entity = e.id
          where e.id in (${placeholders})`,
      )
      .all<{ id: string; name: string | null }>(...ids);
    const nameById = new Map(infoRows.map((r) => [r.id, r.name]));

    for (const g of grants) {
      // Skip grants whose origin channel no longer exists (deleted/archived)
      // so the sidebar doesn't show a dangling federated entry.
      if (!nameById.has(g.roomId)) continue;

      // Only include channels the caller can actually read (B admins get
      // origin-level access; B members need a receiver grant).
      const fed = await federatedRoomAccess(originDb, globalDb, g.roomId, userDid, {
        spaceDbResolver: openSpaceDb,
        memo: fedMemo,
        accessMemo: memo,
      });
      if (!fed || !fed.canRead) continue;

      out.push(stripNulls({
        id: g.roomId,
        name: nameById.get(g.roomId) ?? undefined,
        // defaultAccess reflects the *effective* access for this caller
        // (capped by their receiver grant), not the origin ceiling — a B
        // member with a 'read' receiver grant on a 'readwrite' origin channel
        // sees defaultAccess 'read' and canWrite false.
        defaultAccess: fed.canWrite ? "readwrite" : "read",
        canRead: true,
        canWrite: fed.canWrite,
        // Real per-user unread count: fed rooms' read positions live in the
        // shared read-state DB (the origin's materializer bumps the caller's
        // row on every new message, even for receiving-space members), so
        // the sidebar dot/bold match native channels.
        unreadCount: fedPositions.get(g.roomId)?.unreadCount ?? 0,
        federated: {
          originSpaceId: origin,
          ...(originInfo?.name ? { originSpaceName: originInfo.name } : {}),
          ...(originInfo?.avatar ? { originSpaceAvatar: originInfo.avatar } : {}),
          permission: g.permission,
        },
      }) as SidebarChannel);
    }
  }
  return out;
}
