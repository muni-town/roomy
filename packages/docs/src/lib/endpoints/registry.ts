/**
 * Complete registry of all Roomy Appserver XRPC endpoints.
 *
 * Every endpoint registered in `packages/appserver/src/appserver.ts`'s
 * `buildRouter()` is documented here with its full request/response schema,
 * authorization requirements, and invalidation behavior.
 */


export interface EndpointParam {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  description: string;
}

export interface EndpointSchema {
  type: string;
  properties: Record<string, { type: string; description: string; optional?: boolean }>;
}

export interface Endpoint {
  nsid: string;
  kind: "query" | "procedure" | "sync";
  description: string;
  sourceFile: string;
  auth: string;
  params?: EndpointParam[];
  inputSchema?: EndpointSchema;
  outputSchema?: EndpointSchema;
  notes?: string[];
  invalidation?: string[];
}

export interface EndpointGroup {
  name: string;
  items: Endpoint[];
}

export const endpoints: EndpointGroup[] = [
  {
    name: "Auth",
    items: [
      {
        nsid: "space.roomy.auth.getConnectionTicket",
        kind: "procedure",
        description:
          "Obtains a single-use WebSocket pre-auth ticket. The browser calls this with a service-auth JWT, then opens a WebSocket directly to the appserver with the ticket as a query parameter. Tickets are 64-char hex strings with a 60-second TTL.",
        sourceFile: "space.roomy.auth.getConnectionTicket.ts",
        auth: "Authenticated (service-auth JWT). Returns 401 if auth.did is null.",
        outputSchema: {
          type: "object",
          properties: {
            ticket: { type: "string", description: "Single-use 64-char hex ticket. Valid for 60 seconds." },
          },
        },
        notes: [
          "Tickets are stored in an in-memory Map with 60s TTL.",
          "Periodic cleanup every 5 minutes removes expired entries.",
          "Consumed once on WebSocket upgrade; subsequent calls to the same ticket fail.",
        ],
      },
    ],
  },
  {
    name: "Spaces",
    items: [
      {
        nsid: "space.roomy.space.getSpaces",
        kind: "query",
        description:
          "Returns all spaces where the caller is a member OR an admin (the two are orthogonal). Includes per-space metadata and caller capabilities. When `includeLeft=true`, also returns spaces the user has previously left (with `isMember=false`).",
        sourceFile: "space.roomy.space.getSpaces.ts",
        auth: "Authenticated. Anonymous users get an empty list.",
        params: [
          { name: "includeLeft", type: "string", required: false, description: "When 'true' or '1', includes spaces the user has left (isMember=false)." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            spaces: {
              type: "Array<SpaceRow>",
              description: "List of spaces the caller has access to. Each SpaceRow has: id, name, avatar, description, unreadCount, isMember, isAdmin, roleIds.",
            },
          },
        },
        notes: [
          "isMember and isAdmin are independent — both, either, or neither may be true.",
          "unreadCount is computed only over rooms the caller has read access to.",
          "Hydrates the caller's membership (joinedSpace edges), then queries local SQLite for the union.",
        ],
        invalidation: [
          "Caller joins/leaves a space (member edge added/removed)",
          "Caller's admin edge added/removed",
          "Caller's role assignments change",
          "Unread counts change in any reachable room",
          "A role's room permissions change affecting reachable rooms",
        ],
      },
      {
        nsid: "space.roomy.space.getMetadata",
        kind: "query",
        description:
          "Returns space metadata AND the complete sidebar tree in a single response. The server handles orphan detection (channels not pinned to any category) that was previously done client-side. Channels the caller cannot read are omitted from each category and from orphans.",
        sourceFile: "space.roomy.space.getMetadata.ts",
        auth: "Caller must be a member OR admin of the space.",
        params: [
          { name: "spaceId", type: "string", required: true, description: "DID of the space stream." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string | null", description: "Space display name." },
            avatar: { type: "string | null", description: "Space avatar URL." },
            description: { type: "string | null", description: "Space description." },
            joinPolicy: { type: "object", description: "allowPublicJoin (default true), allowMemberInvites (default false)." },
            isMember: { type: "boolean", description: "Caller has 'member' edge." },
            isAdmin: { type: "boolean", description: "Caller has 'admin' edge (orthogonal to membership)." },
            sidebar: { type: "object", description: "Sidebar tree with categories, channels, orphans. Each channel has: id, name, defaultAccess, canRead, canWrite, unreadCount, lastRead." },
          },
        },
        notes: [
          "The sidebar is filtered server-side: channels the caller cannot read are omitted.",
          "canRead is always true on returned entries (unreadable channels are omitted entirely).",
          "canWrite distinguishes read-only from read-write access.",
          "Replaces the separate #metadataQuery and #sidebarQuery from the LiveQuery era.",
        ],
        invalidation: [
          "Sidebar config changes",
          "Channel creation, deletion, rename",
          "Channel default_access changes",
          "Message activity (unread count changes)",
          "Space name/avatar/description changes",
          "Join policy changes",
          "Caller's admin edge added/removed",
          "Caller's role assignments change",
          "Any role's role_rooms entry changes for this space",
        ],
      },
      {
        nsid: "space.roomy.space.getThreads",
        kind: "query",
        description:
          "Returns all rooms (channels + threads) in a space for the index board, ordered by latest activity, with per-room activity metadata. Supports cursor-based pagination. Rooms are hidden when unreadable to the caller (threads inherit visibility from their canonical parent channel).",
        sourceFile: "space.roomy.space.getThreads.ts",
        auth: "Caller must be a member OR admin of the space.",
        params: [
          { name: "spaceId", type: "string", required: true, description: "DID of the space stream." },
          { name: "limit", type: "int", required: false, default: "50", description: "Items per page (1-100)." },
          { name: "cursor", type: "string", required: false, description: "Opaque cursor from previous response for pagination." },
          { name: "search", type: "string", required: false, description: "Case-insensitive substring filter on room name." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            rooms: { type: "Array<RoomRow>", description: "List of rooms. Each has: id, kind ('thread' | 'channel'), name, channel, channelName (threads), unreadCount, unread, activity (latestTimestamp, latestMembers, latestMessage)." },
            cursor: { type: "string | undefined", description: "Present when more pages are available." },
          },
        },
        notes: [
          "Despite the NSID this endpoint returns channels AND threads; the name is historical.",
          "Uses a per-request access memo to avoid re-querying space-level membership for each room.",
          "Batch-fetches read positions and channel names for all rooms in one query each.",
          "Invalidated on message create/edit/delete (board reorder + preview) and on updateSeen (unread dots, caller-scoped).",
        ],
      },
      {
        nsid: "space.roomy.space.getRoles",
        kind: "query",
        description:
          "Returns all roles defined in a space, with their per-room permissions and assigned members. Drives the roles settings page and the role-permission picker. Soft-deleted roles are omitted.",
        sourceFile: "space.roomy.space.getRoles.ts",
        auth: "Caller must be a member OR admin of the space.",
        params: [
          { name: "spaceId", type: "string", required: true, description: "DID of the space stream." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            roles: { type: "Array<RoleRow>", description: "List of roles. Each has: id, name, avatar, description, rooms (Array<{roomId, permission}>), memberDids (string[])." },
          },
        },
        notes: [
          "Roles with deleted=1 are omitted from results.",
          "Non-admin callers only see roles they are assigned to.",
        ],
        invalidation: [
          "Role create/update/delete",
          "addMemberRole / removeMemberRole",
          "setRoleRoomPermission",
        ],
      },
      {
        nsid: "space.roomy.space.getMembers",
        kind: "query",
        description:
          "Returns all members of a space with profile data, plus admins-without-membership as externalAdmins. An optional `search` param filters by case-insensitive substring match against handle, name, or DID — used by the mention typeahead.",
        sourceFile: "space.roomy.space.getMembers.ts",
        auth: "Caller must be a member OR admin of the space.",
        params: [
          { name: "spaceId", type: "string", required: true, description: "DID of the space stream." },
          { name: "search", type: "string", required: false, description: "Case-insensitive substring filter on handle, name, or DID." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            members: { type: "Array<MemberRow>", description: "Members with: did, handle, name, avatar, isAdmin, roleIds." },
            externalAdmins: { type: "Array<ExternalAdmin>", description: "Admins who are NOT members (admin ⊥ membership). Each has: did, handle, name, avatar." },
          },
        },
        notes: [
          "Admin and membership are orthogonal — externalAdmins are returned separately.",
          "Profile fields may be null when the user hasn't been hydrated yet.",
        ],
        invalidation: [
          "Member join/leave",
          "Admin edge add/remove",
          "Role assignment changes for any member",
          "Profile updates for any member of this space",
        ],
      },
      {
        nsid: "space.roomy.space.getInvites",
        kind: "query",
        description:
          "Returns active invite tokens. Caller-scoped: admins see all invites for the space; non-admin members see only invites they themselves created. Returns Forbidden if allow_member_invites is disabled and caller is not admin.",
        sourceFile: "space.roomy.space.getInvites.ts",
        auth: "Caller must be a member OR admin. Non-admins blocked when allow_member_invites=0.",
        params: [
          { name: "spaceId", type: "string", required: true, description: "DID of the space stream." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            invites: { type: "Array<InviteRow>", description: "List of invites. Each has: token, createdBy (DID), eventUlid." },
          },
        },
        invalidation: [
          "createInvite / revokeInvite events",
          "Caller's admin edge changes (admins see a different set)",
        ],
      },
      {
        nsid: "space.roomy.space.getSpaceSummary",
        kind: "query",
        description:
          "Lightweight read of a space's display fields (name, avatar) only. Skips the sidebar tree, active threads, read positions, and per-channel access checks that make getMetadata expensive. Used for badge enrichment when rendering internal links.",
        sourceFile: "space.roomy.space.getSpaceSummary.ts",
        auth: "Anonymous callers may read public spaces. Banned callers get 403.",
        params: [
          { name: "spaceId", type: "string", required: true, description: "DID of the space stream." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string | undefined", description: "Space display name." },
            avatar: { type: "string | undefined", description: "Space avatar URL." },
          },
        },
        notes: [
          "One SQL row, one ban check, no fan-out. Much cheaper than getMetadata.",
          "No hydrateUserMembership needed — the ban table is space-scoped.",
        ],
      },
      {
        nsid: "space.roomy.space.getActivityFeed",
        kind: "query",
        description:
          "Returns a paginated, chronologically-ordered feed of recent activity across a user's joined spaces (or a single space if spaceId is provided). One item per room (channel or thread), with up to 5 most recent messages and unread counts. Filtered by the caller's room-level read access.",
        sourceFile: "space.roomy.space.getActivityFeed.ts",
        auth: "Authenticated. Returns empty feed for anonymous users.",
        params: [
          { name: "spaceId", type: "string", required: false, description: "Filter to a single space." },
          { name: "limit", type: "int", required: false, default: "50", description: "Items per page (1-100)." },
          { name: "cursor", type: "string", required: false, description: "Opaque cursor from previous response." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            feed: { type: "Array<ActivityFeedItem>", description: "Feed items. Each has: threadId, threadName, spaceId, spaceName, spaceAvatar, channelId, channelName, lastActivityAt, activityType, messages (up to 5), unreadCount." },
            cursor: { type: "string | undefined", description: "Present when more pages are available." },
          },
        },
        notes: [
          "One item per room — channels and threads each get their own row.",
          "Newest-first, sorted by lastActivityAt descending.",
          "Cursor format is {timestamp}::{roomId} (opaque to clients).",
          "Items are materialized at write time into the activity_item table.",
          "Deleted rooms and inaccessible rooms are silently excluded.",
        ],
      },
      {
        nsid: "space.roomy.space.createSpace",
        kind: "procedure",
        description:
          "Creates a new space. Registers a new stream DID (PLC), then seeds it with default events (updateSpaceInfo, createRoom for #general, updateSidebar, addAdmin) via the local event store. Joins the caller as a member and records a joinedSpace edge so the space is immediately visible.",
        sourceFile: "space.roomy.space.createSpace.ts",
        auth: "Authenticated. Requires a valid user DID.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Space display name." },
            description: { type: "string", description: "Space description.", optional: true },
            avatar: { type: "string", description: "Space avatar URL.", optional: true },
            allowPublicJoin: { type: "boolean", description: "Whether anyone can join without an invite.", optional: true },
            allowMemberInvites: { type: "boolean", description: "Whether members can create invites.", optional: true },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            spaceId: { type: "string", description: "DID of the newly created space stream." },
          },
        },
        notes: [
          "PLC registration is irreversible — if a later step fails, the entities row is deleted best-effort but the DID stands.",
          "Emits direct getSpaces + getMetadata invalidation signals for the caller to avoid race conditions with async materialization.",
        ],
      },
      {
        nsid: "space.roomy.space.joinSpace",
        kind: "procedure",
        description:
          "Joins a space. Validates invite tokens for private spaces, appends the space-side joinSpace event to the local event store, and writes the joinedSpace edge directly so the space is immediately visible in the caller's space list.",
        sourceFile: "space.roomy.space.joinSpace.ts",
        auth: "Authenticated. Requires a valid user DID.",
        inputSchema: {
          type: "object",
          properties: {
            spaceId: { type: "string", description: "DID of the space stream to join." },
            inviteToken: { type: "string", description: "Invite token for private spaces.", optional: true },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            spaceId: { type: "string", description: "DID of the joined space." },
          },
        },
        notes: [
          "Removes any previous 'leftSpace' edge so the space reappears in getSpaces.",
          "On join, the SDK's materializer pre-marks all existing channels as read.",
          "Emits direct getSpaces + getMetadata invalidation signals for the caller.",
        ],
      },
      {
        nsid: "space.roomy.space.leaveSpace",
        kind: "procedure",
        description:
          "Leaves a space. Appends the space-side leaveSpace event to the local event store and writes a 'leftSpace' edge so the space appears with includeLeft=true. Emits direct invalidation signals to close the race window with async materialization.",
        sourceFile: "space.roomy.space.leaveSpace.ts",
        auth: "Authenticated. Caller must be a member or admin of the space.",
        inputSchema: {
          type: "object",
          properties: {
            spaceId: { type: "string", description: "DID of the space stream to leave." },
          },
        },
        notes: [
          "Admin edge survives leave/rejoin — admins remain admins even after leaving.",
          "Emits direct getSpaces + getMetadata invalidation signals for the caller to avoid race conditions.",
        ],
      },
      {
        nsid: "space.roomy.space.setHandle",
        kind: "procedure",
        description:
          "Sets or removes a space handle (DNS-based approach). The handle is persisted in the local DB for fast query access. Requires admin access on the space.",
        sourceFile: "space.roomy.space.setHandle.ts",
        auth: "Authenticated. Caller must be an admin of the space.",
        inputSchema: {
          type: "object",
          properties: {
            spaceId: { type: "string", description: "DID of the space stream." },
            handle: { type: "string | null", description: "Handle to set, or null to remove.", optional: true },
          },
        },
        notes: [
          "The handle was historically a Leaf-level registration with a leaf:// DID alias; that registration is no longer performed — the handle is only persisted locally.",
          "Invalidates getMetadata and getSpaces for all viewers of this space.",
        ],
      },
    ],
  },
  {
    name: "Rooms",
    items: [
      {
        nsid: "space.roomy.room.getMetadata",
        kind: "query",
        description:
          "Returns room metadata with recently active threads included. The recentThreads field replaces the separate getLinkedRooms query. For threads, defaultAccess is resolved server-side by following the link edge to the parent channel.",
        sourceFile: "space.roomy.room.getMetadata.ts",
        auth: "Caller must have read access to the room (admin, default_access != none, or matching role grant).",
        params: [
          { name: "roomId", type: "string", required: true, description: "ULID of the room entity." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string | undefined", description: "Room display name." },
            kind: { type: "string", description: "Room kind: 'channel', 'thread', or 'page'." },
            spaceId: { type: "string", description: "DID of the parent space." },
            defaultAccess: { type: "'readwrite' | 'read' | 'none'", description: "For threads: inherited from parent channel." },
            canRead: { type: "boolean", description: "Caller-scoped read permission." },
            canWrite: { type: "boolean", description: "Caller-scoped write permission." },
            lastRead: { type: "string | null", description: "ISO timestamp of last read position." },
            unreadCount: { type: "number", description: "Number of unread messages." },
            recentThreads: { type: "Array<RecentThread>", description: "Recently active threads with: id, name, canRead, canWrite, unreadCount, lastRead." },
          },
        },
        notes: [
          "For threads, defaultAccess is resolved by following the 'link' edge to the parent channel.",
          "Returns Forbidden if the caller has no read access.",
        ],
        invalidation: [
          "Room name/kind changes",
          "Room default_access changes",
          "Unread count changes",
          "Thread activity in this room",
          "Caller's admin edge or role assignments change",
          "A role's permission for this room changes",
        ],
      },
      {
        nsid: "space.roomy.room.getRoomSummary",
        kind: "query",
        description:
          "Lightweight read of a room's display fields (name, kind, spaceId) only. Skips listThreadActivity, per-thread roomAccess, and read positions that make getMetadata expensive. One SQL row plus the single requireRoomRead access check.",
        sourceFile: "space.roomy.room.getRoomSummary.ts",
        auth: "Caller must have read access to the room.",
        params: [
          { name: "roomId", type: "string", required: true, description: "ULID of the room entity." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string | undefined", description: "Room display name." },
            kind: { type: "string", description: "Room kind (channel, thread, page)." },
            spaceId: { type: "string", description: "DID of the parent space." },
          },
        },
        notes: [
          "Badge-enrichment counterpart to getMetadata — much cheaper.",
          "No memo needed (no loop), single access check.",
        ],
      },
      {
        nsid: "space.roomy.room.getMessages",
        kind: "query",
        description:
          "Paginated message history for a room. Returns fully denormalized message objects with all joins resolved server-side. This is the most complex query (joins 10+ tables). Cursor is a message entity ID (ULID), not a timestamp, to handle concurrent messages correctly.",
        sourceFile: "space.roomy.room.getMessages.ts",
        auth: "Caller must have read access to the room.",
        params: [
          { name: "roomId", type: "string", required: true, description: "ULID of the room entity." },
          { name: "limit", type: "int", required: false, default: "50", description: "Messages per page (1-100)." },
          { name: "cursor", type: "string", required: false, description: "Message entity ID for cursor-based pagination (messages older than this ID)." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            messages: { type: "Array<MessageDto>", description: "Messages. Each has: id, content, authorDid, authorName, authorAvatar, timestamp, replyTo, forwardedFrom (with nested denormalised message), reactions, media, tags." },
            cursor: { type: "string | null", description: "Next page cursor, null if no more pages." },
          },
        },
        notes: [
          "Cursor is a message entity ID (ULID), not a timestamp — handles concurrent messages correctly.",
          "Includes forwarded messages (follows 'forward' edge to get original content).",
          "Read-driven embed prioritisation: jumps never-attempted link cards ahead of the backfill backlog.",
        ],
      },
      {
        nsid: "space.roomy.room.getThreads",
        kind: "query",
        description:
          "All threads canonically linked from the given channel, filtered by the caller's read access. Supports cursor-based pagination.",
        sourceFile: "space.roomy.room.getThreads.ts",
        auth: "Caller must have read access to the channel.",
        params: [
          { name: "roomId", type: "string", required: true, description: "ULID of the channel entity." },
          { name: "limit", type: "int", required: false, default: "50", description: "Threads per page (1-100)." },
          { name: "cursor", type: "string", required: false, description: "Opaque cursor from previous response." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            threads: { type: "Array<ThreadRow>", description: "Threads. Each has: id, name, canonicalParent, unreadCount, activity (latestTimestamp, latestMembers)." },
            cursor: { type: "string | undefined", description: "Present when more pages are available." },
          },
        },
        notes: [
          "Uses a per-request access memo to avoid re-querying space-level membership for each thread.",
        ],
      },
      {
        nsid: "space.roomy.room.updateSeen",
        kind: "procedure",
        description:
          "Marks messages in a room as read up to a given message entity. The appserver is the source of truth for read positions. Resets the Engaged push-digest batch for this (user, room).",
        sourceFile: "space.roomy.room.updateSeen.ts",
        auth: "Caller must have read access to the room.",
        inputSchema: {
          type: "object",
          properties: {
            roomId: { type: "string", description: "ULID of the room to mark as seen." },
            seenUpTo: { type: "string", description: "Optional message entity ID (ULID) to use as the high-water mark. Omit to mark all current messages as seen.", optional: true },
          },
        },
        notes: [
          "If seenUpTo is provided: looks up the sort_idx for that message, computes remaining unread count.",
          "If seenUpTo is omitted: marks everything as read (unread_count = 0).",
          "Upserts into the read_positions table (per-user, per-room).",
          "Emits #invalidate signals for room.getMetadata, space.getMetadata, and space.getSpaces scoped to the caller.",
        ],
      },
    ],
  },
  {
    name: "Messages",
    items: [
      {
        nsid: "space.roomy.message.getMessage",
        kind: "query",
        description:
          "Single message by ID. The message's room is resolved first, then read access on that room is enforced before assembling the message. Returns the same shape as a single message object from room.getMessages.",
        sourceFile: "space.roomy.message.getMessage.ts",
        auth: "Caller must have read access to the message's room.",
        params: [
          { name: "messageId", type: "string", required: true, description: "ULID of the message entity." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Message entity ID." },
            content: { type: "string", description: "Raw markdown content." },
            authorDid: { type: "string", description: "DID of the author." },
            authorName: { type: "string", description: "Display name of the author." },
            authorAvatar: { type: "string | null", description: "Avatar URL of the author." },
            timestamp: { type: "string", description: "ISO timestamp." },
            replyTo: { type: "string | null", description: "Parent message ID." },
            forwardedFrom: { type: "{ messageId: string; name: string; roomId: string; message?: MessageDto } | null", description: "Original source if forwarded; message carries the fully denormalised original." },
            reactions: { type: "Array<{ emoji: string; dids: string[] }>", description: "Reactions grouped by emoji." },
            media: { type: "Array<{ url: string; type: string; alt: string | null }>", description: "Attached media." },
            tags: { type: "string[]", description: "Message tags." },
          },
        },
        notes: [
          "Read-driven embed prioritisation: jumps this message's never-attempted links ahead of the backfill backlog.",
          "Client-side cache optimisation: use initialData to check the room messages cache first.",
        ],
      },
      {
        nsid: "space.roomy.message.getReactions",
        kind: "query",
        description:
          "Returns the list of reactors for each emoji on a message. Called on hover/tooltip — not part of the message DTO to keep message payloads small. Groups reactions by emoji with full reactor profile info.",
        sourceFile: "space.roomy.message.getReactions.ts",
        auth: "Caller must have read access to the message's room.",
        params: [
          { name: "messageId", type: "string", required: true, description: "ULID of the message entity." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            reactions: { type: "Array<ReactionGroup>", description: "Reactions grouped by emoji. Each group has: emoji, reactors (Array<{did, name, handle?, avatar?}>)." },
          },
        },
        notes: [
          "Resolves the message's room for access control first.",
          "Joins with comp_info and comp_user for reactor profile data.",
        ],
      },
    ],
  },
  {
    name: "Users",
    items: [
      {
        nsid: "space.roomy.user.getProfile",
        kind: "query",
        description:
          "Get a user's Roomy profile. Served from the appserver's materialized profile data (comp_info/comp_user), which is fetched Roomy-first (space.roomy.user.profile/self PDS record) with Bluesky fallback.",
        sourceFile: "space.roomy.user.getProfile.ts",
        auth: "Authenticated.",
        params: [
          { name: "actor", type: "string", required: true, description: "DID or handle of the user to fetch the profile for." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            did: { type: "string", description: "User DID." },
            handle: { type: "string | undefined", description: "AT Protocol handle." },
            displayName: { type: "string | undefined", description: "Display name." },
            description: { type: "string | undefined", description: "Profile description." },
            pronouns: { type: "string | undefined", description: "Pronouns text." },
            website: { type: "string | undefined", description: "Website URL." },
            avatar: { type: "string | undefined", description: "Avatar URL." },
            banner: { type: "string | undefined", description: "Banner image URL." },
          },
        },
      },
    ],
  },
  {
    name: "Sync",
    items: [
      {
        nsid: "space.roomy.sync.subscribe",
        kind: "sync",
        description:
          "Multiplexed WebSocket subscription for real-time data. A single connection carries all real-time data as typed CBOR frames. The client subscribes/unsubscribes to topics; the server pushes message diffs, unread-count deltas, and invalidation signals.",
        sourceFile: "space.roomy.sync.subscribe.ts",
        auth: "WebSocket pre-auth ticket (obtained via getConnectionTicket procedure).",
        notes: [
          "Client sends JSON text frames: sub/unsub for topics (space:<id>, room:<id>, stream:<id>); cursor triggers a full invalidation.",
          "Server sends CBOR binary frames: #messageDiff (add/update/remove), #roomMetadataDiff (unread delta), #invalidate (query stale), #streamEvents (raw events), #error.",
          "SDK auto-resubscribes all topics on reconnect; each connect mints a fresh ticket (single-use).",
          "Subscribing to a room topic immediately invalidates room.getMetadata, room.getMessages, and room.getThreads so the client re-fetches anything missed while disconnected.",
          "Cursor-based replay of missed diffs is a future concern — reconnection always means HTTP re-fetch.",
          "No persistence across restarts — clients receive full invalidation on restart.",
        ],
      },
    ],
  },
  {
    name: "Push Notifications",
    items: [
      {
        nsid: "space.roomy.push.getVapidPublicKey",
        kind: "query",
        description:
          "Returns the appserver's VAPID public key (base64url) for the browser to pass to pushManager.subscribe({ applicationServerKey }). Public — no auth required. Returns an empty string when VAPID isn't configured; the client should treat a falsy/empty key as 'push unavailable'.",
        sourceFile: "space.roomy.push.getVapidPublicKey.ts",
        auth: "None (public endpoint).",
        outputSchema: {
          type: "object",
          properties: {
            publicKey: { type: "string", description: "VAPID public key in base64url format. Empty string when push is not configured." },
          },
        },
      },
      {
        nsid: "space.roomy.push.getPreferences",
        kind: "query",
        description:
          "Returns the caller's notification preferences: a user-wide default level plus any per-space overrides.",
        sourceFile: "space.roomy.push.getPreferences.ts",
        auth: "Authenticated.",
        outputSchema: {
          type: "object",
          properties: {
            default: { type: "Level", description: "User-wide default notification level." },
            perSpace: { type: "Array<{ spaceId: string; level: Level }>", description: "Per-space notification level overrides." },
          },
        },
      },
      {
        nsid: "space.roomy.push.registerSubscription",
        kind: "procedure",
        description:
          "Stores a browser PushSubscription for the caller, keyed by (userDid, endpoint). Idempotent on endpoint: re-registering the same endpoint updates its keys/expiry rather than duplicating.",
        sourceFile: "space.roomy.push.registerSubscription.ts",
        auth: "Authenticated.",
        inputSchema: {
          type: "object",
          properties: {
            endpoint: { type: "string", description: "Push subscription endpoint URL." },
            keys: { type: "object", description: "Object with non-empty 'p256dh' and 'auth' strings." },
            expirationTime: { type: "number | null", description: "Optional subscription expiration time.", optional: true },
          },
        },
      },
      {
        nsid: "space.roomy.push.unregisterSubscription",
        kind: "procedure",
        description:
          "Removes a stored PushSubscription by endpoint. Called on explicit unsubscribe / logout. Idempotent: unregistering an unknown endpoint is not an error.",
        sourceFile: "space.roomy.push.unregisterSubscription.ts",
        auth: "Authenticated.",
        inputSchema: {
          type: "object",
          properties: {
            endpoint: { type: "string", description: "Push subscription endpoint URL to remove." },
          },
        },
      },
      {
        nsid: "space.roomy.push.setPreferences",
        kind: "procedure",
        description:
          "Sets the user-wide default notification level and/or a per-space override. At least one of default/level must be provided. When spaceId is present, level is required.",
        sourceFile: "space.roomy.push.setPreferences.ts",
        auth: "Authenticated.",
        inputSchema: {
          type: "object",
          properties: {
            default: { type: "Level", description: "User-wide default notification level.", optional: true },
            spaceId: { type: "string", description: "Space DID for per-space override.", optional: true },
            level: { type: "Level", description: "Notification level for the specified space.", optional: true },
          },
        },
        notes: [
          "On joinSpace: the join flow sends the chosen level via this endpoint immediately after joinSpace returns.",
        ],
      },
    ],
  },
  {
    name: "Feature Flags",
    items: [
      {
        nsid: "space.roomy.getFlags",
        kind: "query",
        description:
          "Returns the set of feature flag keys that are enabled for the calling user. All flags default to false. A flag is enabled if the admin has set it globally (all users) or assigned the caller's DID specifically.",
        sourceFile: "space.roomy.getFlags.ts",
        auth: "Authenticated.",
        outputSchema: {
          type: "object",
          properties: {
            flags: { type: "string[]", description: "List of enabled feature flag keys for this user." },
          },
        },
      },
    ],
  },
  {
    name: "Admin",
    items: [
      {
        nsid: "space.roomy.admin.getDashboardStats",
        kind: "query",
        description:
          "Returns aggregate counters + system health for the admin dashboard overview. Includes activity stats (activeSpaces, totalEvents, eventsToday, connectedUsers) and system stats (uptime, appserverDid, dbSizeBytes, pushVapidConfigured, pushTotalSubscriptions).",
        sourceFile: "space.roomy.admin.getDashboardStats.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
        outputSchema: {
          type: "object",
          properties: {
            activity: { type: "object", description: "activeSpaces, totalEvents, eventsToday, connectedUsers." },
            system: { type: "object", description: "uptime, appserverDid, dbSizeBytes, pushVapidConfigured, pushTotalSubscriptions." },
          },
        },
      },
      {
        nsid: "space.roomy.admin.listSpaces",
        kind: "query",
        description:
          "Paginated, per-space stats for the admin dashboard. Each row carries member/event counters and an event-type breakdown for one space, sorted by member count descending. Cursor format: '<memberCount>|<did>'.",
        sourceFile: "space.roomy.admin.listSpaces.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
        params: [
          { name: "limit", type: "int", required: false, default: "50", description: "Spaces per page (max 100)." },
          { name: "cursor", type: "string", required: false, description: "Opaque cursor from previous response." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            spaces: { type: "Array<AdminSpaceStats>", description: "Per-space stats: did, name, memberCount, totalEvents, eventsToday, eventBreakdown." },
            cursor: { type: "string | undefined", description: "Present when more pages are available." },
          },
        },
      },
      {
        nsid: "space.roomy.admin.connectSpace",
        kind: "query",
        description:
          "Returns basic info about a space — the service DID we authenticated as, plus the rooms list from the materialized DB. Used to validate connectivity from clients.",
        sourceFile: "space.roomy.admin.connectSpace.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
        params: [
          { name: "did", type: "string", required: true, description: "DID of the space stream to inspect." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            serviceDid: { type: "string", description: "The appserver's own DID." },
            streamDid: { type: "string", description: "The requested space stream DID." },
            roomCount: { type: "number", description: "Number of rooms in the space." },
            rooms: { type: "unknown[]", description: "List of rooms with id, name, kind, deleted, parent." },
          },
        },
      },
      {
        nsid: "space.roomy.admin.materializeSpace",
        kind: "query",
        description:
          "Reports the current materialization state for a stream by reading cursor from events.stream_state and backfill status from comp_space.backfilled_to. Includes per-room entity counts for diagnosing missing events.",
        sourceFile: "space.roomy.admin.materializeSpace.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
        params: [
          { name: "did", type: "string", required: true, description: "DID of the space stream to inspect." },
        ],
        outputSchema: {
          type: "object",
          properties: {
            streamDid: { type: "string", description: "The requested space stream DID." },
            cursor: { type: "number", description: "Current materialization cursor (latest event idx)." },
            backfillSettled: { type: "boolean", description: "Whether backfill has completed." },
            rooms: { type: "Array<{ roomId: string; entityCount: number }>", description: "Per-room entity counts, sorted by count descending." },
          },
        },
      },
      {
        nsid: "space.roomy.admin.getFlags",
        kind: "query",
        description:
          "Returns the full state of every registered feature flag: key, description, whether it's enabled globally, and the list of assigned DIDs.",
        sourceFile: "space.roomy.admin.getFlags.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
        outputSchema: {
          type: "object",
          properties: {
            flags: { type: "Array<FlagState>", description: "Each flag has: key, description, globalEnabled, assignedDids." },
          },
        },
      },
      {
        nsid: "space.roomy.admin.setFlag",
        kind: "procedure",
        description:
          "Sets a feature flag: enables/disables globally, and/or assigns/removes specific DIDs.",
        sourceFile: "space.roomy.admin.setFlag.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
      },
      {
        nsid: "space.roomy.admin.clearFlag",
        kind: "procedure",
        description:
          "Clears a feature flag entirely (removes all state).",
        sourceFile: "space.roomy.admin.clearFlag.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
      },
      {
        nsid: "space.roomy.admin.push.getSubscriptions",
        kind: "query",
        description:
          "Lists all push subscriptions for diagnostic purposes.",
        sourceFile: "space.roomy.admin.push.getSubscriptions.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
      },
      {
        nsid: "space.roomy.admin.push.getStats",
        kind: "query",
        description:
          "Returns push notification statistics for the admin dashboard.",
        sourceFile: "space.roomy.admin.push.getStats.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
      },
      {
        nsid: "space.roomy.admin.push.testSend",
        kind: "procedure",
        description:
          "Sends a test push notification to verify push delivery is working.",
        sourceFile: "space.roomy.admin.push.testSend.ts",
        auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
      },
    ],
  },
];

/** Flatten all endpoints for lookup by NSID. */
export const endpointByNsid: Record<string, Endpoint> = {};
for (const group of endpoints) {
  for (const ep of group.items) {
    endpointByNsid[ep.nsid] = ep;
  }
}

