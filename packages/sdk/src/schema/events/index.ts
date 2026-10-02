// Re-export types and utilities for materializers
export type { SqlStatement } from "../../types";
export { sql } from "../../utils/sqlTemplate";
export { decodeTime } from "ulidx";
export { fromBytes } from "@atcute/cbor";

export { eventRegistry, getDependsOn, getMaterializer } from "./registry";
export { defineEvent, ensureEntity, edgePayload } from "./utils";

// Export event variants
export { MessageEventVariant } from "./message";
export { RoomEventVariant } from "./room";
export { ReactionEventVariant } from "./reaction";
export { SpaceEventVariant } from "./space";
export { PageEventVariant } from "./page";
export { UserEventVariant } from "./user";
export { LinkEventVariant } from "./link";
export { CalendarEventVariant } from "./calendar";
export { InviteEventVariant } from "./invite";
export { StateEventVariant } from "./state";
export { FederationEventVariant } from "./federation";

export { VoiceEventVariant } from "./voice";
// Export synthetic events
export {
  syntheticEventRegistry,
  getSyntheticMaterializer,
  type SyntheticEvent,
  type SyntheticEventType,
} from "./synthetic";

// Export defined events with their materializers
export {
  CreateMessage,
  EditMessage,
  DeleteMessage,
  MoveMessages,
  ReorderMessage,
  ForwardMessages,
} from "./message";
export { CreateRoom, UpdateRoom, DeleteRoom, RestoreRoom } from "./room";
export {
  AddReaction,
  RemoveReaction,
  AddBridgedReaction,
  RemoveBridgedReaction,
} from "./reaction";
export {
  JoinSpace,
  LeaveSpace,
  UpdateSpaceInfo,
  UpdateSidebarV0,
  UpdateSidebar,
  AddAdmin,
  RemoveAdmin,
  SetHandleProvider as SetHandle,
} from "./space";
export { EditPage } from "./page";
export { SetUserProfile } from "./user";
export { CreateRoomLink, RemoveRoomLink } from "./link";
export { SetCalendarLink } from "./calendar";
export { CreateInvite, RevokeInvite } from "./invite";
export {
  FederationRequest,
  FederationRespond,
  FederationRemove,
  SetRoomPermission,
  SetReceiverPermission,
} from "./federation";
export { MarkRead } from "./state";
export {
  CreateRole,
  DeleteRole,
  UpdateRole,
  AddMemberRole,
  RemoveMemberRole,
  SetRoleRoomPermission,
  RoleEventVariant,
} from "./roles";

export { CallStarted, CallJoined, CallLeft, CallEnded } from "./voice";
export type { CallFactSource } from "./voice";

export {
  type MaterializeContext,
  type MaterializeFn,
  type DependsOnFn,
  type DefinedEvent,
} from "./types";
