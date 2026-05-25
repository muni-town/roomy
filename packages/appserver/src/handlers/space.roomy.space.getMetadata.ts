/**
 * XRPC: space.roomy.space.getMetadata (query).
 *
 * Returns space metadata + the complete sidebar tree filtered by the caller's
 * read access. Channels the caller cannot read are omitted from each category
 * (and from `orphans`). Stage-1: unreadCount/lastRead are 0/null.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { roomAccess, spaceAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { getReadPositions } from "../queries/readPositions.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import { stripNulls } from "../xrpc/strip-nulls.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface SidebarChannel {
  id: string;
  name?: string;
  defaultAccess: "readwrite" | "read" | "none";
  canRead: boolean;
  canWrite: boolean;
  unreadCount: number;
  lastRead?: string;
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
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }
  const spaceId = requireString(params, "spaceId");

  await hydrateUserMembership(userDid);

  const db = openDb();
  const access = spaceAccess(db, spaceId, userDid);

  if (access.isBanned) {
    throw new XrpcError(403, "Forbidden", "Caller is banned from this space");
  }

  // Non-members get public info only (name, avatar, joinPolicy) — no sidebar.
  // This allows the join-space modal to show in the UI.
  const isMemberOrAdmin = access.isMember || access.isAdmin;

  const spaceRow = db
    .query<
      {
        name: string | null;
        avatar: string | null;
        description: string | null;
        allow_public_join: number | null;
        allow_member_invites: number | null;
        sidebar_config: string;
      },
      [string]
    >(
      `select
           ci.name as name,
           ci.avatar as avatar,
           ci.description as description,
           cs.allow_public_join as allow_public_join,
           cs.allow_member_invites as allow_member_invites,
           cs.sidebar_config as sidebar_config
         from comp_space cs
         left join comp_info ci on ci.entity = cs.entity
        where cs.entity = ?`,
    )
    .get(spaceId);

  if (spaceRow === null) {
    throw new XrpcError(404, "NotFound", `Space not found: ${spaceId}`);
  }

  let config: SidebarConfig;
  try {
    const parsed = JSON.parse(spaceRow.sidebar_config);
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

  if (isMemberOrAdmin) {
    const allChannelRows = db
      .query<
        {
          id: string;
          name: string | null;
          default_access: string | null;
        },
        [string]
      >(
        `select e.id as id, ci.name as name, cr.default_access as default_access
             from entities e
             join comp_room cr on cr.entity = e.id
             left join comp_info ci on ci.entity = e.id
            where e.stream_id = ?
              and cr.label = 'space.roomy.channel'
              and coalesce(cr.deleted, 0) = 0`,
      )
      .all(spaceId);

    const channelById = new Map(allChannelRows.map((r) => [r.id, r]));

    // Batch-fetch read positions for all channels in this space.
    const readPositions = getReadPositions(
      db,
      userDid,
      allChannelRows.map((r) => r.id),
    );

    const buildChannel = (id: string): SidebarChannel | null => {
      const row = channelById.get(id);
      if (!row) return null;
      const acc = roomAccess(db, id, userDid);
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
    categories = config.categories.map((cat, idx) => {
      const channels: SidebarChannel[] = [];
      for (const childId of cat.children ?? []) {
        referencedIds.add(childId);
        const ch = buildChannel(childId);
        if (ch) channels.push(ch);
      }
      return stripNulls({
        id: cat.id ?? null,
        name: cat.name,
        position: idx,
        channels,
      }) as SidebarCategory;
    });

    for (const row of allChannelRows) {
      if (referencedIds.has(row.id)) continue;
      const ch = buildChannel(row.id);
      if (ch) orphans.push(ch);
    }
  }

  // Deleted rooms — only fetched when explicitly requested
  let deletedRooms: DeletedRoom[] | undefined;
  if (params.includeDeleted === "true") {
    const deletedRows = db
      .query<
        { id: string; name: string | null },
        [string]
      >(
        `select e.id as id, ci.name as name
           from entities e
           join comp_room cr on cr.entity = e.id
           left join comp_info ci on ci.entity = e.id
          where e.stream_id = ?
            and cr.label = 'space.roomy.channel'
            and cr.deleted = 1`,
      )
      .all(spaceId);
    deletedRooms = deletedRows.map((r) =>
      stripNulls({ id: r.id, name: r.name }) as DeletedRoom,
    );
  }

  return stripNulls({
    name: spaceRow.name,
    avatar: spaceRow.avatar,
    description: spaceRow.description,
    joinPolicy: {
      // null = unset → defaults per schema comments.
      allowPublicJoin: spaceRow.allow_public_join !== 0,
      allowMemberInvites: spaceRow.allow_member_invites === 1,
    },
    isMember: access.isMember,
    isAdmin: access.isAdmin,
    sidebar: { categories, orphans },
    deletedRooms,
  }) as GetMetadataResult;
};
