/**
 * The record kinds the materialiser will read instead of events.
 *
 * `docs/plans/replicable-space-workers.md` §5 WS3 collapses the 47 event
 * types onto 16 record kinds. This file is that collapse as data: for each
 * kind, its collection, what keys it, and the shape of its body. The adapter
 * in `toRecordChanges.ts` maps events onto these; the projection rules (S2 and
 * S3) are written per kind rather than per event.
 *
 * **The NSIDs are provisional.** They are proposed here so the adapter has one
 * stable name per kind; no lexicon JSON is generated from them and nothing
 * outside this directory consumes them. `space.roomy.user.profile` is the one
 * collection that already exists (`lexicons/space/roomy/user/profile.json`);
 * every other entry is a proposal, and `space.roomy.record.*` may win over the
 * area-based names below once the lexicon workstream settles them.
 *
 * Three shapes are fixed by the plan and not negotiable here: a room is
 * soft-deleted so `op: delete` is never used for one, a room link is a `parent`
 * field on the linked room's record rather than a kind of its own, and a room
 * permission with a null level is a delete.
 */

import type { CallFactSource, Did, RoomKind, StreamDid } from "@roomy-space/sdk";

/**
 * A room's default access level. The SDK exports the arktype schema, not the
 * inferred type, so the three literals are written out — the same three
 * `auth/access.ts` uses.
 */
export type DefaultAccess = "readwrite" | "read" | "none";

/** A role's or a federation grant's access level. */
export type Permission = "read" | "readwrite";

/** A message body: the mime type and the raw bytes the event carried. */
export interface MessageContent {
  readonly mimeType: string;
  /** The content bytes, decoded from the event's `{ buf }`/CBOR form. */
  readonly data: Uint8Array;
}

/**
 * A message whose text the projection derives rather than the log carrying it.
 *
 * `createRoomLink` renders `"@<did> created [<room name>](…)"` by reading
 * `comp_info.name` at materialisation time, so the text is a function of
 * projection state and cannot be replayed from the event alone. The record
 * carries the structured fact and the rule renders it, which also keeps the
 * acting DID (named in the mention) an explicit field instead of something a
 * consumer would recover by parsing markdown.
 */
export interface MessageSystemRoomLink {
  readonly kind: "roomLink";
  /** The linked room — the same id the accompanying `room` record updates. */
  readonly linkToRoom: string;
  /** `"created [x]"` rather than `"linked to [x]"`. */
  readonly isCreationLink: boolean;
}

/** Fields every message record carries, whatever produced it. */
interface MessageEnvelopeFields {
  /** The room the message lives in. */
  readonly room: string;
  /**
   * The message's author: a user DID, or the space DID for a system message
   * `link.ts` attributes to the stream. A bridged message names the overridden
   * author. Equal to the record's `repo` for every message with one.
   */
  readonly author: Did;
  /** Who performed the action, when that is not the author (system messages). */
  readonly actor?: Did;
  /** The event's extensions, unopened. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * A message record's body, in the three states one can be in: content it
 * carries, a system text the rule renders, or a `forwardMessages` reference
 * that has no body of its own.
 */
export type MessageRecord = MessageEnvelopeFields &
  (
    | { readonly content: MessageContent; readonly system?: never; readonly forwardOf?: never }
    | { readonly content?: never; readonly system: MessageSystemRoomLink; readonly forwardOf?: never }
    | { readonly content?: never; readonly system?: never; readonly forwardOf: readonly string[] }
  );

/** The write `editMessage`/`moveMessages` carries against an existing message. */
export interface MessagePatch {
  /** `moveMessages`: the destination room. */
  readonly room?: string;
  /** `editMessage`: the body that replaces the current one. */
  readonly content?: MessageContent;
  /**
   * `editMessage`: the attachment set. Absent means "leave it alone"; `null`
   * means "remove all attachments"; a map replaces it.
   */
  readonly extensions?: Readonly<Record<string, unknown>> | null;
}

/**
 * `reaction` — created by `addReaction`/`addBridgedReaction`, deleted by the
 * matching remove event. Keyed by the **add** event's id, which is what
 * `comp_reaction.reaction_id` stores, so a removal can name the record it
 * removes.
 */
export interface ReactionRecord {
  /** The message being reacted to. */
  readonly target: string;
  /** The reacting user — the bridged event's `reactingUser`, not its sender. */
  readonly user: Did;
  /** The emoji, or a URI describing one. */
  readonly reaction: string;
  /**
   * Set by the bridged add. The rule materialises the reacting user's entity
   * only then: a local reaction is sent by a member the space already holds,
   * while the bridged user may be an external account with no entity.
   */
  readonly bridged?: true;
}

/**
 * `room` — created by `createRoom`; updated by `updateRoom`, the soft
 * delete/restore pair, and the room-link pair (which carries `parent`).
 *
 * `parent` is load-bearing for authorization, not presentation: `roomAccess`
 * resolves a thread's access through its canonical parent. Rooms are never
 * `op: delete` — a deleted room stays in the set with `deleted: true`, which is
 * what `getMetadata`'s `deletedRooms` list and the restore modal read.
 */
export interface RoomRecord {
  readonly kind: RoomKind;
  readonly name: string | null;
  readonly avatar: string | null;
  readonly description: string | null;
  /** Threads carry no access level of their own; they inherit the parent's. */
  readonly defaultAccess: DefaultAccess | null;
  readonly deleted: boolean;
  readonly parent: string | null;
  readonly discordOrigin?: {
    readonly snowflake: string;
    readonly guildId: string;
  };
}

/** The fields `updateRoom` and the link/delete/restore events may set. */
export interface RoomPatch {
  readonly kind?: RoomKind;
  readonly name?: string | null;
  readonly avatar?: string | null;
  readonly description?: string | null;
  readonly defaultAccess?: DefaultAccess;
  readonly deleted?: boolean;
  /** The linking room's id (`createRoomLink`), or `null` (`removeRoomLink`). */
  readonly parent?: string | null;
}

/** The space's own profile and join policy — see `SpaceInfoRecord`. */
export interface SpaceInfoRecord {
  readonly name: string | null;
  readonly avatar: string | null;
  readonly description: string | null;
  /** `null` = unset, which reads as open. */
  readonly allowPublicJoin: boolean | null;
  /** `null` = unset, which reads as allowed. */
  readonly allowMemberInvites: boolean | null;
  /** `null` = admins have not answered; reads as suggested. */
  readonly suggestToOthers: boolean | null;
}

/**
 * `spaceInfo` — the space's profile and join policy, one record per space.
 * Only `updateSpaceInfo` writes it, and it writes a patch.
 */
export type SpaceInfoPatch = Partial<SpaceInfoRecord>;

/** One sidebar category, in either the v0 (no ids) or v1 form. */
export interface SidebarCategory {
  readonly id?: string;
  readonly name: string;
  readonly children: readonly string[];
}

/**
 * `spaceSidebar` — the space's sidebar ordering, one record per space. Both
 * `updateSidebar` versions overwrite the whole config, so this is the patch
 * shape as well as the record shape.
 */
export interface SpaceSidebarRecord {
  readonly categories: readonly SidebarCategory[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * `membership` — one record per member, created by `joinSpace`, updated by
 * `addAdmin`/`removeAdmin`, deleted by `leaveSpace`.
 *
 * `can` mirrors the `member` edge's payload. `joinSpace` emits `"post"` even
 * for a rejoin by an admin, because the projection's "rejoin keeps admin" rule
 * reads state the adapter does not have; `addAdmin` is what restores it.
 */
export interface MembershipRecord {
  readonly user: Did;
  readonly can: "post" | "admin";
}

/** `removeAdmin`: keep the member, drop the admin bit. */
export interface MembershipPatch {
  readonly can: "post" | "admin";
}

/** `ban` — one record per banned account. */
export interface BanRecord {
  readonly user: Did;
}

/** `invite` — one record per live invite token, keyed by the token itself. */
export interface InviteRecord {
  readonly token: string;
  readonly createdBy: Did;
}

/**
 * `role` — created by `createRole`, updated by `updateRole`, deleted by
 * `deleteRole`. The projection sets `roles.deleted = 1` instead of removing the
 * row; every reader filters on it and no event restores a role, so removal from
 * the set is the same read result.
 */
export interface RoleRecord {
  readonly name: string | null;
  readonly avatar: string | null;
  readonly description: string | null;
}

/** The fields `updateRole` carried. */
export type RolePatch = Partial<RoleRecord>;

/** `roleGrant` — one record per (member, role) pair. */
export interface RoleGrantRecord {
  readonly user: Did;
  readonly role: string;
}

/**
 * `roomPermission` — one record per (role, room) pair. `setRoleRoomPermission`
 * carries the whole record, so this is the patch shape too; a `null` permission
 * is a delete.
 */
export interface RoomPermissionRecord {
  readonly role: string;
  readonly room: string;
  readonly permission: Permission;
}

/**
 * `federationRequest` — the A↔B relationship, keyed by the federating space.
 * Created by `federation.request`, updated by `federation.respond`, deleted by
 * `federation.remove`.
 *
 * No timestamp in the body: the projection's `requested_at`/`decided_at` are
 * `Date.now()` at materialisation, which is not a value the log determines.
 */
export interface FederationRequestRecord {
  readonly federatingSpace: StreamDid;
  readonly requestedBy: Did;
  readonly message: string | null;
}

/** The write `federation.respond` carries. */
export interface FederationRequestPatch {
  readonly status: "active" | "rejected";
  readonly decidedBy: Did;
  readonly message: string | null;
}

/** Who in the receiving space a receiver grant applies to. */
export type GrantGranteeKind = "members" | "user" | "role";

/** One channel's grant inside a receiving space's grant record. */
export interface OriginGrant {
  readonly room: string;
  readonly permission: Permission;
}

/** One channel's grant for one grantee of the receiving space. */
export interface ReceiverGrant extends OriginGrant {
  readonly grantee: string;
  readonly granteeKind: GrantGranteeKind;
}

/**
 * `federationGrant` — everything one receiving space (B) may see of this space
 * (A), as a single record kexed by B: the origin grants are what B may see, and
 * the receiver grants are which of B's members may see it, capped by the origin
 * grant.
 *
 * One record per B rather than one per (room, grantee) because the only event
 * that removes grants, `federation.remove`, names B alone — a per-room record
 * could not be deleted by it, and the plan's "one event, two deletes" would
 * become a number of deletes the event cannot determine.
 */
export interface FederationGrantRecord {
  readonly federatingSpace: StreamDid;
  readonly origin: readonly OriginGrant[];
  readonly receiver: readonly ReceiverGrant[];
}

/**
 * One entry changed. A `null` level clears the entry, so the two setter events
 * are updates to this record whichever way they go.
 */
export type FederationGrantPatch =
  | {
      readonly scope: "origin";
      readonly room: string;
      readonly permission: Permission | null;
    }
  | {
      readonly scope: "receiver";
      readonly room: string;
      readonly grantee: string;
      readonly granteeKind: GrantGranteeKind;
      readonly permission: Permission | null;
    };

/**
 * `profile` — a user's profile. `updateProfile` names a `did` that is the
 * record's subject *and* its repo: the write exists so a bridge or an admin can
 * set a profile the subject did not write, which the protocol model cannot
 * express in the subject's repo. Flagged rather than reconstructed; see
 * `toRecordChanges.ts`.
 */
export interface ProfileRecord {
  readonly name: string | null;
  readonly avatar: string | null;
  readonly description: string | null;
  /** Set only by the Discord bridge extension; absent means "leave it alone". */
  readonly handle?: string;
}

/** The fields `updateProfile` carried. */
export type ProfilePatch = Partial<ProfileRecord>;

/**
 * `calendarLink` — the OpenMeet group a space is connected to, one record per
 * space. `openmeet.configure` with a non-null slug writes it; a null slug is a
 * delete.
 */
export interface CalendarLinkRecord {
  readonly groupSlug: string;
  readonly tenantId: string;
  readonly apiUrl: string;
}

/**
 * `voiceCall` — one record per call, keyed by `callId`. `callStarted` creates
 * it, join/left patch it, `callEnded` deletes it.
 */
export interface VoiceCallRecord {
  readonly room: string;
  readonly source: CallFactSource;
  /**
   * The projection's `active_calls.started_at`: the start event's ULID time.
   * Log-determined, unlike a wall-clock read at materialisation.
   */
  readonly startedAt: number;
}

/** The fact `callJoined`/`callLeft` carries about the call's participant set. */
export type VoiceCallPatch = { readonly source: CallFactSource } & (
  | { readonly joined: Did }
  | { readonly left: Did }
);

/** The full body of each kind — the state a `create` establishes. */
export interface RecordBodyTypes {
  message: MessageRecord;
  reaction: ReactionRecord;
  room: RoomRecord;
  spaceInfo: SpaceInfoRecord;
  spaceSidebar: SpaceSidebarRecord;
  membership: MembershipRecord;
  ban: BanRecord;
  invite: InviteRecord;
  role: RoleRecord;
  roleGrant: RoleGrantRecord;
  roomPermission: RoomPermissionRecord;
  federationRequest: FederationRequestRecord;
  federationGrant: FederationGrantRecord;
  profile: ProfileRecord;
  calendarLink: CalendarLinkRecord;
  voiceCall: VoiceCallRecord;
}

/**
 * The body an `update` carries for each kind. `never` means the kind has no
 * update: an update to it is a type error rather than a record that changes
 * nothing.
 *
 * Kinds with no `create` are the singletons — `spaceInfo`, `spaceSidebar`,
 * `calendarLink`, `federationGrant` — whose record exists from the space's
 * beginning, so every write to one is an update.
 */
export interface RecordPatchTypes {
  message: MessagePatch;
  reaction: never;
  room: RoomPatch;
  spaceInfo: SpaceInfoPatch;
  spaceSidebar: SpaceSidebarRecord;
  membership: MembershipPatch;
  ban: never;
  invite: never;
  role: RolePatch;
  roleGrant: never;
  roomPermission: RoomPermissionRecord;
  federationRequest: FederationRequestPatch;
  federationGrant: FederationGrantPatch;
  profile: ProfilePatch;
  calendarLink: CalendarLinkRecord;
  voiceCall: VoiceCallPatch;
}

/** One kind's definition: where it lives and what keys it. */
export interface RecordKindSpec {
  /** The collection NSID — provisional except `profile`, which exists. */
  readonly collection: string;
  /**
   * What the rkey is made of, in order; parts are joined with `:`. Empty for a
   * singleton, whose rkey is the literal `self`.
   */
  readonly rkey: readonly string[];
}

export const RECORD_KINDS = {
  message: {
    collection: "space.roomy.room.message",
    rkey: ["messageId"],
  },
  reaction: {
    collection: "space.roomy.room.reaction",
    rkey: ["reactionId"],
  },
  room: {
    collection: "space.roomy.space.room",
    rkey: ["roomId"],
  },
  spaceInfo: {
    collection: "space.roomy.space.info",
    rkey: [],
  },
  spaceSidebar: {
    collection: "space.roomy.space.sidebar",
    rkey: [],
  },
  membership: {
    collection: "space.roomy.space.membership",
    rkey: ["userDid"],
  },
  ban: {
    collection: "space.roomy.space.ban",
    rkey: ["userDid"],
  },
  invite: {
    collection: "space.roomy.space.invite",
    rkey: ["token"],
  },
  role: {
    collection: "space.roomy.space.role",
    rkey: ["roleId"],
  },
  roleGrant: {
    collection: "space.roomy.space.roleGrant",
    rkey: ["userDid", "roleId"],
  },
  roomPermission: {
    collection: "space.roomy.space.roomPermission",
    rkey: ["roleId", "roomId"],
  },
  federationRequest: {
    collection: "space.roomy.federation.request",
    rkey: ["federatingSpace"],
  },
  federationGrant: {
    collection: "space.roomy.federation.grant",
    rkey: ["federatingSpace"],
  },
  profile: {
    collection: "space.roomy.user.profile",
    rkey: [],
  },
  calendarLink: {
    collection: "space.roomy.space.calendarLink",
    rkey: [],
  },
  voiceCall: {
    collection: "space.roomy.voice.call",
    rkey: ["callId"],
  },
} as const satisfies Record<keyof RecordBodyTypes, RecordKindSpec>;

/** The name of a record kind. */
export type RecordKind = keyof typeof RECORD_KINDS;

/** One kind's collection NSID. */
export type Nsid<K extends RecordKind> = (typeof RECORD_KINDS)[K]["collection"];

/** A kind's full body. */
export type FullBody<K extends RecordKind> = RecordBodyTypes[K];

/** The body a kind's `update` carries. */
export type PatchBody<K extends RecordKind> = RecordPatchTypes[K];

// Each map must name every kind, in both directions: a new kind without a body
// (or a body without a kind) is a compile error rather than an `undefined` that
// only shows up at runtime.
type Assert<T extends true> = T;
type _BodiesCoverKinds = Assert<
  RecordKind extends keyof RecordBodyTypes ? true : never
>;
type _KindsCoverBodies = Assert<
  keyof RecordBodyTypes extends RecordKind ? true : never
>;
type _PatchesCoverKinds = Assert<
  RecordKind extends keyof RecordPatchTypes ? true : never
>;
