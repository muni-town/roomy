import { Event, EventType } from "../envelope";
import { Ulid } from "../primitives";
import { CreateRoomLink, RemoveRoomLink } from "./link";
import {
  CreateMessage,
  EditMessage,
  DeleteMessage,
  MoveMessages,
  ReorderMessage,
  ForwardMessages,
} from "./message";
import { EditPage } from "./page";
import {
  AddReaction,
  RemoveReaction,
  AddBridgedReaction,
  RemoveBridgedReaction,
} from "./reaction";
import { CreateRoom, UpdateRoom, DeleteRoom } from "./room";
import {
  JoinSpace,
  LeaveSpace,
  PersonalJoinSpace,
  PersonalLeaveSpace,
  UpdateSpaceInfo,
  UpdateSidebarV0,
  UpdateSidebar,
  AddAdmin,
  RemoveAdmin,
  SetHandleProvider,
} from "./space";
import { DefinedEvent, MaterializeFn } from "./types";
import { SetUserProfile, SetLastRead } from "./user";

/** Registry of all defined events by their $type */
export const eventRegistry = {
  "space.roomy.message.createMessage.v0": CreateMessage,
  "space.roomy.message.editMessage.v0": EditMessage,
  "space.roomy.message.deleteMessage.v0": DeleteMessage,
  "space.roomy.message.moveMessages.v0": MoveMessages,
  "space.roomy.message.reorderMessage.v0": ReorderMessage,
  "space.roomy.message.forwardMessages.v0": ForwardMessages,
  "space.roomy.room.createRoom.v0": CreateRoom,
  "space.roomy.room.updateRoom.v0": UpdateRoom,
  "space.roomy.room.deleteRoom.v0": DeleteRoom,
  "space.roomy.reaction.addReaction.v0": AddReaction,
  "space.roomy.reaction.removeReaction.v0": RemoveReaction,
  "space.roomy.reaction.addBridgedReaction.v0": AddBridgedReaction,
  "space.roomy.reaction.removeBridgedReaction.v0": RemoveBridgedReaction,
  "space.roomy.space.joinSpace.v0": JoinSpace,
  "space.roomy.space.leaveSpace.v0": LeaveSpace,
  "space.roomy.space.personal.joinSpace.v0": PersonalJoinSpace,
  "space.roomy.space.personal.leaveSpace.v0": PersonalLeaveSpace,
  "space.roomy.space.updateSpaceInfo.v0": UpdateSpaceInfo,
  "space.roomy.space.updateSidebar.v0": UpdateSidebarV0,
  "space.roomy.space.updateSidebar.v1": UpdateSidebar,
  "space.roomy.space.addAdmin.v0": AddAdmin,
  "space.roomy.space.removeAdmin.v0": RemoveAdmin,
  "space.roomy.space.setHandleProvider.v0": SetHandleProvider,
  "space.roomy.page.editPage.v0": EditPage,
  "space.roomy.user.updateProfile.v0": SetUserProfile,
  "space.roomy.space.personal.setLastRead.v0": SetLastRead,
  "space.roomy.link.createRoomLink.v0": CreateRoomLink,
  "space.roomy.link.removeRoomLink.v0": RemoveRoomLink,
} as const satisfies Record<EventType, DefinedEvent<any, boolean>>;

/** Get the causal dependencies for an event */
export function getDependsOn(event: {
  $type: string;
  [key: string]: unknown;
}): (typeof Ulid.infer)[] {
  const eventDef = eventRegistry[event.$type as keyof typeof eventRegistry];
  if (!eventDef?.dependsOn) return [];
  return eventDef.dependsOn(event as any) || [];
}

/** Get the materializer for an event type */
export function getMaterializer<T extends EventType>(eventType: T) {
  return eventRegistry[eventType]?.materialize as unknown as MaterializeFn<
    Event<T>
  >;
}
