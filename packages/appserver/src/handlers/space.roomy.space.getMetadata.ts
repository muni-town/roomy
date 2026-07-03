/**
 * XRPC: space.roomy.space.getMetadata (query).
 *
 * Returns space metadata + the complete sidebar tree filtered by the caller's
 * read access. Channels the caller cannot read are omitted from each category
 * (and from `orphans`). Stage-1: unreadCount/lastRead are 0/null.
 */

import { roomAccess, spaceAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { getReadPositions } from "../queries/readPositions.ts";
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

  const db = openDb();
  // Metadata (name, avatar, joinPolicy, isMember) is required to render the
  // join / accept-invite UI for spaces the caller is not yet a member of —
  // including invite-only spaces. We therefore don't require read membership
  // here: compute the access decision directly and only block banned callers.
  // The channel/thread sidebar below is still gated on membership, so
  // non-members receive an empty sidebar.
  const access = await spaceAccess(db, spaceId, userDid);
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
  if (userDid !== null && (access.isMember || access.isAdmin)) {
    const allChannelRows = await db
      .query(
        `select e.id as id, ci.name as name, cr.default_access as default_access
             from entities e
             join comp_room cr on cr.entity = e.id
             left join comp_info ci on ci.entity = e.id
            where e.stream_id = ?
              and cr.label = 'space.roomy.channel'
              and coalesce(cr.deleted, 0) = 0`,
      )
      .all<{
        id: string;
        name: string | null;
        default_access: string | null;
      }>(spaceId);

    const channelById = new Map(allChannelRows.map((r) => [r.id, r]));

    // Batch-fetch read positions for all channels in this space.
    const readPositions = await getReadPositions(
      db,
      userDid,
      allChannelRows.map((r) => r.id as string),
    );

    const buildChannel = async (id: string): Promise<SidebarChannel | null> => {
      const row = channelById.get(id);
      if (!row) return null;
      const acc = await roomAccess(db, id, userDid);
      if (!acc.canRead) return null;
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

    const referencedIds = new Set<string>();
    categories = await Promise.all(config.categories.map(async (cat, idx) => {
      const channels: SidebarChannel[] = [];
      for (const childId of cat.children ?? []) {
        referencedIds.add(childId);
        const ch = await buildChannel(childId);
        if (ch) channels.push(ch);
      }
      return stripNulls({
        id: cat.id ?? null,
        name: cat.name,
        position: idx,
        channels,
      }) as SidebarCategory;
    }));

    for (const row of allChannelRows) {
      if (referencedIds.has(row.id as string)) continue;
      const ch = await buildChannel(row.id as string);
      if (ch) orphans.push(ch);
    }

    // ── Active threads ────────────────────────────────────────────────
    // Fetch up to 8 threads the user has recently interacted with and
    // distribute them into their parent channels for the sidebar.
    const activeThreadEntries = await queryActiveThreads(db, userDid, spaceId);

    if (activeThreadEntries.length > 0) {
      const threadIds = activeThreadEntries.map((t) => t.id);
      const threadMetaMap = await resolveThreadsByIds(db, threadIds);

      // Build active thread objects with access checks and read positions.
      const threadReadPositions = await getReadPositions(db, userDid, threadIds);
      const activeThreadsByParent = new Map<string, ActiveSidebarThread[]>();

      for (const entry of activeThreadEntries) {
        const meta = threadMetaMap.get(entry.id);
        if (!meta) continue;

        const acc = await roomAccess(db, entry.id, userDid);
        if (!acc.canRead) continue;

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
    sidebar: { categories, orphans },
    ...(deletedRooms !== undefined ? { deletedRooms } : {}),
  }) as GetMetadataResult;
};
