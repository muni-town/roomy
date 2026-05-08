/**
 * XRPC: space.roomy.space.getMetadata (query).
 *
 * Returns space metadata + the complete sidebar tree filtered by the caller's
 * read access. Channels the caller cannot read are omitted from each category
 * (and from `orphans`). Stage-1: unreadCount/lastRead are 0/null.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { roomAccess } from "../auth/access.ts";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { requireSpaceAccess } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface SidebarChannel {
  id: string;
  name: string | null;
  defaultAccess: "readwrite" | "read" | "none";
  canRead: boolean;
  canWrite: boolean;
  unreadCount: number;
  lastRead: string | null;
}

interface SidebarCategory {
  id: string | null; // null for v0 (legacy categories with no stable id)
  name: string;
  position: number;
  channels: SidebarChannel[];
}

interface GetMetadataResult {
  name: string | null;
  avatar: string | null;
  description: string | null;
  joinPolicy: { allowPublicJoin: boolean; allowMemberInvites: boolean };
  isMember: boolean;
  isAdmin: boolean;
  sidebar: { categories: SidebarCategory[]; orphans: SidebarChannel[] };
}

interface SidebarConfig {
  categories: Array<{
    id?: string;
    name: string;
    children: string[];
  }>;
}

export const getMetadataHandler: QueryHandler<QueryParams, GetMetadataResult> =
  async (params: QueryParams, auth: AuthCtx) => {
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
    const access = requireSpaceAccess(db, spaceId, userDid);

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

    const buildChannel = (id: string): SidebarChannel | null => {
      const row = channelById.get(id);
      if (!row) return null;
      const acc = roomAccess(db, id, userDid);
      if (!acc.canRead) return null;
      return {
        id: row.id,
        name: row.name,
        defaultAccess: acc.defaultAccess,
        canRead: acc.canRead,
        canWrite: acc.canWrite,
        unreadCount: 0, // stage-1
        lastRead: null, // stage-1
      };
    };

    const referencedIds = new Set<string>();
    const categories: SidebarCategory[] = config.categories.map((cat, idx) => {
      const channels: SidebarChannel[] = [];
      for (const childId of cat.children ?? []) {
        referencedIds.add(childId);
        const ch = buildChannel(childId);
        if (ch) channels.push(ch);
      }
      return {
        id: cat.id ?? null,
        name: cat.name,
        position: idx,
        channels,
      };
    });

    const orphans: SidebarChannel[] = [];
    for (const row of allChannelRows) {
      if (referencedIds.has(row.id)) continue;
      const ch = buildChannel(row.id);
      if (ch) orphans.push(ch);
    }

    return {
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
    };
  };
