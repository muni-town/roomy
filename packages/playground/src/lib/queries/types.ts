// ── Response types matching the XRPC interface spec ───────────────────────

export interface Space {
	id: string;
	name: string | null;
	avatar: string | null;
	description: string | null;
	unreadCount: number;
	isMember: boolean;
	isAdmin: boolean;
	roleIds: string[];
}

export interface GetSpacesResponse {
	spaces: Space[];
}

export interface SidebarChannel {
	id: string;
	name: string;
	defaultAccess: "readwrite" | "read" | "none";
	canRead: boolean;
	canWrite: boolean;
	unreadCount: number;
	lastRead: string | null;
}

export interface SidebarCategory {
	id: string;
	name: string;
	position: number;
	channels: SidebarChannel[];
}

export interface GetSpaceMetadataResponse {
	name: string | null;
	avatar: string | null;
	description: string | null;
	joinPolicy: {
		allowPublicJoin: boolean;
		allowMemberInvites: boolean;
	};
	isMember: boolean;
	isAdmin: boolean;
	sidebar: {
		categories: SidebarCategory[];
		orphans: SidebarChannel[];
	};
}

export interface ThreadActivity {
	latestTimestamp: string;
	latestMembers: Array<{
		did: string;
		name: string;
		avatar: string | null;
	}>;
}

export interface Thread {
	id: string;
	name: string;
	channel: string | null;
	activity: ThreadActivity;
}

export interface GetSpaceThreadsResponse {
	threads: Thread[];
}

export interface RoleRoom {
	roomId: string;
	permission: "read" | "readwrite";
}

export interface Role {
	id: string;
	name: string | null;
	avatar: string | null;
	description: string | null;
	rooms: RoleRoom[];
	memberDids: string[];
}

export interface GetRolesResponse {
	roles: Role[];
}

export interface Member {
	did: string;
	handle: string | null;
	name: string | null;
	avatar: string | null;
	isAdmin: boolean;
	roleIds: string[];
}

export interface ExternalAdmin {
	did: string;
	handle: string | null;
	name: string | null;
	avatar: string | null;
}

export interface GetMembersResponse {
	members: Member[];
	externalAdmins: ExternalAdmin[];
}

export interface Invite {
	token: string;
	createdBy: string;
	eventUlid: string;
}

export interface GetInvitesResponse {
	invites: Invite[];
}

export interface RecentThread {
	id: string;
	name: string;
	canRead: boolean;
	canWrite: boolean;
	unreadCount: number;
	lastRead: string | null;
}

export interface GetRoomMetadataResponse {
	name: string;
	kind: string;
	spaceId: string;
	defaultAccess: "readwrite" | "read" | "none";
	canRead: boolean;
	canWrite: boolean;
	lastRead: string | null;
	unreadCount: number;
	recentThreads: RecentThread[];
}

export interface Reaction {
	emoji: string;
	dids: string[];
}

export interface Media {
	url: string;
	type: string;
	alt: string | null;
}

export interface Message {
	id: string;
	content: string;
	authorDid: string;
	authorName: string;
	authorAvatar: string | null;
	timestamp: string;
	replyTo: string | null;
	forwardedFrom: { name: string; roomId: string } | null;
	reactions: Reaction[];
	media: Media[];
	tags: string[];
}

export interface GetMessagesResponse {
	messages: Message[];
	cursor: string | null;
}

export interface RoomThread {
	id: string;
	name: string;
	canonicalParent: string | null;
	activity: ThreadActivity;
}

export interface GetRoomThreadsResponse {
	threads: RoomThread[];
}

// ── WebSocket frame types ─────────────────────────────────────────────────

export interface MessageDiffOp {
	op: "add" | "update" | "remove";
	key: string;
	message?: Message;
}

export interface MessageDiffFrame {
	roomId: string;
	seq: number;
	ops: MessageDiffOp[];
}

export interface InvalidationFrame {
	nsid: string;
	params: Record<string, string>;
}

export interface ErrorFrame {
	error: string;
	message: string;
}
