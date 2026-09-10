/**
 * Hand-written prose for every Roomy Appserver XRPC endpoint.
 *
 * The endpoint *skeleton* (NSID + kind + group) is generated from the
 * appserver router (`scripts/generate-registry.ts` → `nsids.generated.json`).
 * This file holds the human-authored documentation: descriptions, auth
 * requirements, params, schemas, notes, and invalidation signals.
 *
 * `registry.ts` merges the two into the catalogue the UI consumes.
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

export interface EndpointProse {
  description: string;
  auth: string;
  params?: EndpointParam[];
  inputSchema?: EndpointSchema;
  outputSchema?: EndpointSchema;
  notes?: string[];
  invalidation?: string[];
}

export const prose: Record<string, EndpointProse> = {
  // ── Auth ────────────────────────────────────────────────────────────────
  "space.roomy.auth.getConnectionTicket": {
    description:
      "Obtains a single-use WebSocket pre-auth ticket. The browser calls this with a service-auth JWT, then opens a WebSocket directly to the appserver with the ticket as a query parameter. Tickets are 64-char hex strings with a 60-second TTL.",
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

  // ── Spaces ──────────────────────────────────────────────────────────────
  "space.roomy.space.getSpaces": {
    description:
      "Returns all spaces where the caller is a member OR an admin (the two are orthogonal). Includes per-space metadata and caller capabilities. When `includeLeft=true`, also returns spaces the user has previously left (with `isMember=false`).",
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
  "space.roomy.space.getMetadata": {
    description:
      "Returns space metadata AND the complete sidebar tree in a single response. The server handles orphan detection (channels not pinned to any category) that was previously done client-side. Channels the caller cannot read are omitted from each category and from orphans.",
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
  "space.roomy.space.getThreads": {
    description:
      "Returns all rooms (channels + threads) in a space for the index board, ordered by latest activity, with per-room activity metadata. Supports cursor-based pagination. Rooms are hidden when unreadable to the caller (threads inherit visibility from their canonical parent channel).",
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
  "space.roomy.space.getRoles": {
    description:
      "Returns all roles defined in a space, with their per-room permissions and assigned members. Drives the roles settings page and the role-permission picker. Soft-deleted roles are omitted.",
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
  "space.roomy.space.getMembers": {
    description:
      "Returns all members of a space with profile data, plus admins-without-membership as externalAdmins. An optional `search` param filters by case-insensitive substring match against handle, name, or DID — used by the mention typeahead.",
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
  "space.roomy.space.getInvites": {
    description:
      "Returns active invite tokens. Caller-scoped: admins see all invites for the space; non-admin members see only invites they themselves created. Returns Forbidden if allow_member_invites is disabled and caller is not admin.",
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
  "space.roomy.space.getSpaceSummary": {
    description:
      "Lightweight read of a space's display fields (name, avatar) only. Skips the sidebar tree, active threads, read positions, and per-channel access checks that make getMetadata expensive. Used for badge enrichment when rendering internal links.",
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
  "space.roomy.space.getActivityFeed": {
    description:
      "Returns a paginated, chronologically-ordered feed of recent activity across a user's joined spaces (or a single space if spaceId is provided). One item per room (channel or thread), with up to 5 most recent messages and unread counts. Filtered by the caller's room-level read access.",
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
  "space.roomy.space.createSpace": {
    description:
      "Creates a new space. Registers a new stream DID (PLC), then seeds it with default events (updateSpaceInfo, createRoom for #general, updateSidebar, addAdmin) via the local event store. Joins the caller as a member and records a joinedSpace edge so the space is immediately visible.",
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
  "space.roomy.space.joinSpace": {
    description:
      "Joins a space. Validates invite tokens for private spaces, appends the space-side joinSpace event to the local event store, and writes the joinedSpace edge directly so the space is immediately visible in the caller's space list.",
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
  "space.roomy.space.leaveSpace": {
    description:
      "Leaves a space. Appends the space-side leaveSpace event to the local event store and writes a 'leftSpace' edge so the space appears with includeLeft=true. Emits direct invalidation signals to close the race window with async materialization.",
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
  "space.roomy.space.setHandle": {
    description:
      "Sets or removes a space handle (DNS-based approach). The handle is persisted in the local DB for fast query access. Requires admin access on the space.",
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
  "space.roomy.space.sendEvents": {
    description:
      "Sends a batch of Roomy events to a space stream. The appserver validates authorization per-event, then writes events directly to the events DB and materializes inline. This is the write path behind every client action (messages, reactions, room changes, …).",
    auth: "Authenticated; per-event authorization via writeAuth (admin, membership, and room write rules).",
    notes: [
      "Events are CBOR payloads appended to the stream's event log in a single transaction.",
      "Materialization happens inline: the batch is applied to the view tables and invalidation signals are emitted before the response returns.",
      "See the sendEvents procedure plan in packages/appserver/docs/plans for the full event catalogue.",
    ],
  },
  "space.roomy.space.updatePolicy": {
    description:
      "Reinstalls the appserver's latest arbiter policy on a space's stewarded account. Requires admin access on the space. Upgrades an existing space to the latest policy (e.g. the one that lets Roomy admins act under the space's account).",
    auth: "Authenticated. Caller must be an admin of the space.",
    notes: [
      "When the arbiter is not configured, the procedure is a no-op success.",
      "The appserver acts as the arbiter's recovery admin for every stewarded space.",
    ],
  },
  "space.roomy.space.reorderSpaces": {
    description:
      "Reorders the caller's space list. The order is per-user appserver state stored in the read-state DB — NOT part of the ATProto event stream. The client sends the full ordered list of space DIDs it currently shows (joined spaces only).",
    auth: "Authenticated.",
    notes: [
      "Every DID in the list must be a space the caller has actually joined.",
      "Spaces the caller joined but omitted from the list keep their default position (they sort after the explicitly-ordered ones).",
      "Precedent for non-event-stream state: updateSeen / leaveSpace.",
    ],
  },
  "space.roomy.space.getUserAccess": {
    description:
      "Reports a user's standing in a space: whether they are an admin and which role IDs they hold. The arbiter's Rego policy engine calls this to make access decisions, proxying the request as the stewarded space account.",
    auth: "The caller MUST be the space itself — the request must be authenticated as the space's own DID (signed by the space's key, which the arbiter/PDS holds).",
    notes: [
      "This is a machine-to-machine endpoint for the arbiter, not a client-facing one.",
    ],
  },
  "space.roomy.space.grantBridgeToken": {
    description:
      "Grants the caller's Roomy Pro bridge token to a space. One active grant per grantor — granting while any pending grant exists (to this or another space) is rejected with 409; the caller must explicitly revoke the existing grant first. A spent grant is permanent and cannot be granted again (409).",
    auth: "Authenticated. Capacity is resolved live from Polar (TTL-cached per grantor).",
    notes: [
      "No valid Polar state → 'not a Pro member' error.",
      "Polar unavailable AND no cached state → 503 (nothing known).",
    ],
  },
  "space.roomy.space.revokeBridgeToken": {
    description:
      "Revokes the caller's bridge-token grant for a space. Grantor only — a non-grantor gets 403 (this procedure is how the grantor frees their one active grant). A spent grant (bridged guild exceeded 100 members) is PERMANENT and cannot be revoked — 409.",
    auth: "Authenticated. Grantor only.",
  },
  "space.roomy.space.getBridgeTokens": {
    description:
      "Lists the bridge-token grants a space has received: grantor DID, grant-time capacity snapshot, and spent status. Space members (existing access checks) may read it. Makes NO Polar calls — live validity is only re-resolved by the admin getSpaceMembership endpoint.",
    auth: "Caller must be a member of the space.",
  },

  // ── Rooms ───────────────────────────────────────────────────────────────
  "space.roomy.room.getMetadata": {
    description:
      "Returns room metadata with recently active threads included. The recentThreads field replaces the separate getLinkedRooms query. For threads, defaultAccess is resolved server-side by following the link edge to the parent channel.",
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
  "space.roomy.room.getRoomSummary": {
    description:
      "Lightweight read of a room's display fields (name, kind, spaceId) only. Skips listThreadActivity, per-thread roomAccess, and read positions that make getMetadata expensive. One SQL row plus the single requireRoomRead access check.",
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
  "space.roomy.room.getMessages": {
    description:
      "Paginated message history for a room. Returns fully denormalized message objects with all joins resolved server-side. This is the most complex query (joins 10+ tables). Cursor is a message entity ID (ULID), not a timestamp, to handle concurrent messages correctly.",
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
  "space.roomy.room.getThreads": {
    description:
      "All threads canonically linked from the given channel, filtered by the caller's read access. Supports cursor-based pagination.",
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
  "space.roomy.room.updateSeen": {
    description:
      "Marks messages in a room as read up to a given message entity. The appserver is the source of truth for read positions. Resets the Engaged push-digest batch for this (user, room).",
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

  // ── Messages ─────────────────────────────────────────────────────────────
  "space.roomy.message.getMessage": {
    description:
      "Single message by ID. The message's room is resolved first, then read access on that room is enforced before assembling the message. Returns the same shape as a single message object from room.getMessages.",
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
  "space.roomy.message.getReactions": {
    description:
      "Returns the list of reactors for each emoji on a message. Called on hover/tooltip — not part of the message DTO to keep message payloads small. Groups reactions by emoji with full reactor profile info.",
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

  // ── Users ────────────────────────────────────────────────────────────────
  "space.roomy.user.getProfile": {
    description:
      "Get a user's Roomy profile. Served from the appserver's materialized profile data (comp_info/comp_user), which is fetched Roomy-first (space.roomy.user.profile/self PDS record) with Bluesky fallback.",
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
  "space.roomy.user.getMembershipStatus": {
    description:
      "Returns the caller's Roomy Pro membership status, resolved live from Polar (per-grantor TTL-cached, fail-open on outage). The subscription page calls this to render the current state.",
    auth: "Authenticated.",
    notes: [
      "After a Polar checkout redirect (?checkout={CHECKOUT_ID}) the page passes the checkout ID back as the `checkout` param, which forces a non-cached refresh so the new membership is visible immediately instead of up to 300s of cached 'not a member'.",
    ],
  },

  // ── Sync ────────────────────────────────────────────────────────────────
  "space.roomy.sync.subscribe": {
    description:
      "Multiplexed WebSocket subscription for real-time data. A single connection carries all real-time data as typed CBOR frames. The client subscribes/unsubscribes to topics; the server pushes message diffs, unread-count deltas, and invalidation signals.",
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
  "space.roomy.sync.getEvents": {
    description:
      "ADMIN-ONLY. Returns raw events from stream_events (the event-log DB) for a given stream, after a cursor. Used by the discord-bridge to poll for new events after receiving invalidation signals.",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
  },

  // ── Push Notifications ──────────────────────────────────────────────────
  "space.roomy.push.getVapidPublicKey": {
    description:
      "Returns the appserver's VAPID public key (base64url) for the browser to pass to pushManager.subscribe({ applicationServerKey }). Public — no auth required. Returns an empty string when VAPID isn't configured; the client should treat a falsy/empty key as 'push unavailable'.",
    auth: "None (public endpoint).",
    outputSchema: {
      type: "object",
      properties: {
        publicKey: { type: "string", description: "VAPID public key in base64url format. Empty string when push is not configured." },
      },
    },
  },
  "space.roomy.push.getPreferences": {
    description:
      "Returns the caller's notification preferences: a user-wide default level plus any per-space overrides.",
    auth: "Authenticated.",
    outputSchema: {
      type: "object",
      properties: {
        default: { type: "Level", description: "User-wide default notification level." },
        perSpace: { type: "Array<{ spaceId: string; level: Level }>", description: "Per-space notification level overrides." },
      },
    },
  },
  "space.roomy.push.registerSubscription": {
    description:
      "Stores a browser PushSubscription for the caller, keyed by (userDid, endpoint). Idempotent on endpoint: re-registering the same endpoint updates its keys/expiry rather than duplicating.",
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
  "space.roomy.push.unregisterSubscription": {
    description:
      "Removes a stored PushSubscription by endpoint. Called on explicit unsubscribe / logout. Idempotent: unregistering an unknown endpoint is not an error.",
    auth: "Authenticated.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "Push subscription endpoint URL to remove." },
      },
    },
  },
  "space.roomy.push.setPreferences": {
    description:
      "Sets the user-wide default notification level and/or a per-space override. At least one of default/level must be provided. When spaceId is present, level is required.",
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

  // ── Feature Flags ───────────────────────────────────────────────────────
  "space.roomy.getFlags": {
    description:
      "Returns the set of feature flag keys that are enabled for the calling user. All flags default to false. A flag is enabled if the admin has set it globally (all users) or assigned the caller's DID specifically.",
    auth: "Authenticated.",
    outputSchema: {
      type: "object",
      properties: {
        flags: { type: "string[]", description: "List of enabled feature flag keys for this user." },
      },
    },
  },

  // ── Admin ───────────────────────────────────────────────────────────────
  "space.roomy.admin.getDashboardStats": {
    description:
      "Returns aggregate counters + system health for the admin dashboard overview. Includes activity stats (activeSpaces, totalEvents, eventsToday, connectedUsers) and system stats (uptime, appserverDid, dbSizeBytes, pushVapidConfigured, pushTotalSubscriptions).",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
    outputSchema: {
      type: "object",
      properties: {
        activity: { type: "object", description: "activeSpaces, totalEvents, eventsToday, connectedUsers." },
        system: { type: "object", description: "uptime, appserverDid, dbSizeBytes, pushVapidConfigured, pushTotalSubscriptions." },
      },
    },
  },
  "space.roomy.admin.listSpaces": {
    description:
      "Paginated, per-space stats for the admin dashboard. Each row carries member/event counters and an event-type breakdown for one space, sorted by member count descending. Cursor format: '<memberCount>|<did>'.",
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
  "space.roomy.admin.connectSpace": {
    description:
      "Returns basic info about a space — the service DID we authenticated as, plus the rooms list from the materialized DB. Used to validate connectivity from clients.",
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
  "space.roomy.admin.materializeSpace": {
    description:
      "Reports the current materialization state for a stream by reading cursor from events.stream_state and backfill status from comp_space.backfilled_to. Includes per-room entity counts for diagnosing missing events.",
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
  "space.roomy.admin.getFlags": {
    description:
      "Returns the full state of every registered feature flag: key, description, whether it's enabled globally, and the list of assigned DIDs.",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
    outputSchema: {
      type: "object",
      properties: {
        flags: { type: "Array<FlagState>", description: "Each flag has: key, description, globalEnabled, assignedDids." },
      },
    },
  },
  "space.roomy.admin.setFlag": {
    description:
      "Sets a feature flag: enables/disables globally, and/or assigns/removes specific DIDs.",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
  },
  "space.roomy.admin.clearFlag": {
    description:
      "Clears a feature flag entirely (removes all state).",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
  },
  "space.roomy.admin.push.getSubscriptions": {
    description:
      "Lists all push subscriptions for diagnostic purposes.",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
  },
  "space.roomy.admin.push.getStats": {
    description:
      "Returns push notification statistics for the admin dashboard.",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
  },
  "space.roomy.admin.push.testSend": {
    description:
      "Sends a test push notification to verify push delivery is working.",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
  },
  "space.roomy.admin.getSpaceMembership": {
    description:
      "Returns the bridge-token capacity picture for one space: every grant, its live Polar-derived capacity, spend state, and the space's maxMembers (Σ valid capacities) vs current member count. The Discord bridge polls this endpoint to decide whether bridging may continue: overLimit (memberCount > maxMembers) means the bridge must halt.",
    auth: "Admin allowlist (APPSERVER_ADMIN_DIDS).",
    notes: [
      "Per-grant processing (read-time validity): Polar validity check per grantor (300s TTL cache).",
    ],
  },

  // ── Federation ───────────────────────────────────────────────────────────
  "space.roomy.federation.getRequests": {
    description:
      "Returns the pending federation requests addressed to a space (A). Visible only to that space's admins, who use it to approve or reject requests.",
    auth: "Caller must be an admin of the space.",
  },
  "space.roomy.federation.getIncoming": {
    description:
      "Returns the federations *into* a space (B): relationships where B is the receiving/federating space. Visible to B's admins so they can see which origin spaces expose channels to B and their status.",
    auth: "Caller must be an admin of the space.",
  },
  "space.roomy.federation.getOutgoing": {
    description:
      "Returns the federations *from* a space (A): relationships where A is the origin. Visible to A's admins so they can manage the spaces federated to A (approve/reject/remove) and, in later phases, configure per-channel grants.",
    auth: "Caller must be an admin of the space.",
  },
  "space.roomy.federation.getGrants": {
    description:
      "Returns the per-channel federation grants touching a space, for its admins: originGrants (channels of this space exposed to other spaces) and receiverGrants (channels of other spaces federated into this space, plus the receiver grants B's admins have set for its members/roles). Feeds the settings Federations UI.",
    auth: "Caller must be an admin of the space.",
  },

  // ── Mentions ────────────────────────────────────────────────────────────
  "space.roomy.mention.getMentions": {
    description:
      "Returns recent messages that mention a given DID, across all spaces the caller can read. Used for backfill when a client subscribes to the `mentions:<did>` sync topic — the client fetches history via HTTP, then receives live `#mention` frames.",
    auth: "Authenticated. A caller may only query their own mentions (the DID is the stable ID; eavesdropping on another user's mentions is not allowed).",
  },

  // ── Search ───────────────────────────────────────────────────────────────
  "space.roomy.search.messages": {
    description:
      "Cross-space full-text message search backed by Qdrant. The query is BM25-encoded to a sparse vector and searched against the global messages collection, payload-filtered to the caller's readable spaces (spaceId narrows the filter to one space; roomId narrows it to one room — a channel plus its threads, or a thread plus its parent channel).",
    auth: "Authenticated. Results are post-filtered by per-room read access.",
    notes: [
      "Results are over-fetched (limit×10), hydrated via selectMessages, post-filtered by per-room read access, trimmed to limit, and returned ranked best-match-first.",
    ],
  },
  "space.roomy.search.rooms": {
    description:
      "Search channels and threads in a space by name (case-insensitive substring), filtered by the caller's read access. Backs the forward modal's room picker: unlike space.getMetadata's activeThreads (at most 8 recently-active threads per user), this finds every non-deleted channel and thread whose name matches.",
    auth: "Caller must be a member of the space.",
    notes: [
      "Returns at most `limit` rooms (default 20, max 100) across both kinds, channels first, each alphabetically by name. No cursor: the room picker is a single-shot search.",
    ],
  },

  // ── Embeds ──────────────────────────────────────────────────────────────
  "space.roomy.embed.getLinkMetadata": {
    description:
      "Enriches a URL with link metadata (OpenGraph + oEmbed discovery) so the client can render a rich link preview. This is the appserver-side replacement for the client calling an external embed service directly — enrichment logic now lives in the appserver, is authenticated, and is the seam where ATProto-native enrichment (DID resolution, HappyView, PDS fetches) will later be layered in.",
    auth: "Authenticated.",
    notes: [
      "Best-effort: a URL that can't be fetched (bot-blocked, offline, non-http) returns a minimal result rather than an error.",
    ],
  },
};
