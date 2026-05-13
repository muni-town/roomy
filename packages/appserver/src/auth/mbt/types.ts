/**
 * Typed shape of the decoded `vars` from `auth.qnt` MBT traces.
 *
 * Mirrors the AuthState + OracleSnapshot definitions in
 * packages/appserver/specs/auth.qnt. After `decode()`/`parseTrace()`, the JSON
 * matches these types up to the variant convention `{tag, value}` (with
 * `value: []` for nullary constructors).
 */

import type { DecodedMap, Variant } from "./itf.ts";

// ── Primitives / leaf variants ─────────────────────────────────────────

export type UserId = string; // DID
export type RoomId = string; // ULID
export type RoleId = string;
export type InviteToken = string;

export type Permission =
  | Variant<"None", []>
  | Variant<"Read", []>
  | Variant<"ReadWrite", []>;

export type PermissionTag = Permission["tag"];

export interface PublicJoinConfig {
  publicJoin: boolean;
  allowMemberInvites: boolean;
}

export type LastAuthResult =
  | Variant<"AuthOk", []>
  | Variant<"AuthPermissionDenied", []>;

export type MaybeParent =
  | Variant<"NoParent", []>
  | Variant<"HasParent", RoomId>;

// ── Room sum type ──────────────────────────────────────────────────────

export interface Channel {
  defaultPermission: Permission;
  deleted: boolean;
}

export interface Thread {
  deleted: boolean;
  parent: MaybeParent;
}

export type Room =
  | Variant<"ChannelRoom", Channel>
  | Variant<"ThreadRoom", Thread>;

// ── Role ───────────────────────────────────────────────────────────────

export interface Role {
  members: Set<UserId>;
  channelPermissions: DecodedMap<RoomId, Permission>;
}

// ── AuthState ──────────────────────────────────────────────────────────

export interface AuthState {
  allowPublicJoin: PublicJoinConfig;
  roles: DecodedMap<RoleId, Role>;
  admins: Set<UserId>;
  rooms: DecodedMap<RoomId, Room>;
  members: Set<UserId>;
  invites: Set<InviteToken>;
  bans: Set<UserId>;
  result: LastAuthResult;
}

// ── Oracle snapshot ────────────────────────────────────────────────────

export interface SpecRoomAccess {
  exists: boolean;
  canRead: boolean;
  canWrite: boolean;
  isAdmin: boolean;
  isBanned: boolean;
  defaultAccess: Permission;
  parentChannel: MaybeParent;
}

export interface SpecSpaceAccess {
  isMember: boolean;
  isAdmin: boolean;
  isBanned: boolean;
}

export interface OracleSnapshot {
  // Tuple-keyed: [UserId, RoomId] → SpecRoomAccess
  rooms: DecodedMap<[UserId, RoomId], SpecRoomAccess>;
  // String-keyed: UserId → SpecSpaceAccess
  spaces: DecodedMap<UserId, SpecSpaceAccess>;
}

// ── Top-level: the user-defined state vars in the trace ───────────────

export interface SpecVars {
  state: AuthState;
  oracleSnapshot: OracleSnapshot;
}

// ── Variant → impl-string helpers ──────────────────────────────────────
// access.ts uses string DefaultAccess values. These map the spec's variant
// tags to the impl's encoding.

export type DefaultAccessString = "readwrite" | "read" | "none";

export function permissionToString(p: Permission): DefaultAccessString {
  switch (p.tag) {
    case "None":
      return "none";
    case "Read":
      return "read";
    case "ReadWrite":
      return "readwrite";
  }
}

export function isChannel(r: Room): r is Variant<"ChannelRoom", Channel> {
  return r.tag === "ChannelRoom";
}

export function isThread(r: Room): r is Variant<"ThreadRoom", Thread> {
  return r.tag === "ThreadRoom";
}

export function parentOf(r: Room): RoomId | null {
  if (r.tag !== "ThreadRoom") return null;
  const p = r.value.parent;
  return p.tag === "HasParent" ? (p.value as RoomId) : null;
}

export function isInviteOnly(c: PublicJoinConfig): boolean {
  return !c.publicJoin;
}
