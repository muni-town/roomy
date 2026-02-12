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

// Export defined events with their materializers
export {
  CreateMessage,
  EditMessage,
  DeleteMessage,
  MoveMessages,
  ReorderMessage,
  ForwardMessages,
} from "./message";
export { CreateRoom, UpdateRoom, DeleteRoom } from "./room";
export {
  AddReaction,
  RemoveReaction,
  AddBridgedReaction,
  RemoveBridgedReaction,
} from "./reaction";
export {
  JoinSpace,
  LeaveSpace,
  PersonalJoinSpace,
  PersonalLeaveSpace,
  UpdateSpaceInfo,
  UpdateSidebarV0,
  UpdateSidebar,
  AddAdmin,
  RemoveAdmin,
  SetHandleProvider as SetHandle,
} from "./space";
export { EditPage } from "./page";
export { SetUserProfile, SetLastRead } from "./user";
export { CreateRoomLink, RemoveRoomLink } from "./link";

export {
  type MaterializeContext,
  type MaterializeFn,
  type DependsOnFn,
  type DefinedEvent,
} from "./types";
