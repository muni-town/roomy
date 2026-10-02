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
import { CreateRoom, UpdateRoom, DeleteRoom, RestoreRoom } from "./room";
import {
  JoinSpace,
  LeaveSpace,
  UpdateSpaceInfo,
  UpdateSidebarV0,
  UpdateSidebar,
  AddAdmin,
  RemoveAdmin,
  SetHandleProvider,
  UnbanAccount,
  BanAccount,
} from "./space";
import { CreateInvite, RevokeInvite } from "./invite";
import { MarkRead } from "./state";
import { DefinedEvent, MaterializeFn } from "./types";
import { SetUserProfile } from "./user";
import { SetCalendarLink } from "./calendar";
import {
  CreateRole,
  DeleteRole,
  UpdateRole,
  AddMemberRole,
  RemoveMemberRole,
  SetRoleRoomPermission,
} from "./roles";
import {
  FederationRequest,
  FederationRespond,
  FederationRemove,
  SetRoomPermission,
  SetReceiverPermission,
} from "./federation";

import {
  CallStarted,
  CallJoined,
  CallLeft,
  CallEnded,
} from "./voice";

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
  "space.roomy.room.restoreRoom.v0": RestoreRoom,
  "space.roomy.reaction.addReaction.v0": AddReaction,
  "space.roomy.reaction.removeReaction.v0": RemoveReaction,
  "space.roomy.reaction.addBridgedReaction.v0": AddBridgedReaction,
  "space.roomy.reaction.removeBridgedReaction.v0": RemoveBridgedReaction,
  "space.roomy.space.joinSpace.v0": JoinSpace,
  "space.roomy.space.leaveSpace.v0": LeaveSpace,
  "space.roomy.space.updateSpaceInfo.v0": UpdateSpaceInfo,
  "space.roomy.space.updateSidebar.v0": UpdateSidebarV0,
  "space.roomy.space.updateSidebar.v1": UpdateSidebar,
  "space.roomy.space.addAdmin.v0": AddAdmin,
  "space.roomy.space.removeAdmin.v0": RemoveAdmin,
  "space.roomy.space.setHandleProvider.v0": SetHandleProvider,
  "space.roomy.page.editPage.v0": EditPage,
  "space.roomy.user.updateProfile.v0": SetUserProfile,
  "space.roomy.link.createRoomLink.v0": CreateRoomLink,
  "space.roomy.link.removeRoomLink.v0": RemoveRoomLink,
  "space.roomy.openmeet.configure.v0": SetCalendarLink,
  "space.roomy.state.markRead.v0": MarkRead,
  "space.roomy.space.banAccount.v0": BanAccount,
  "space.roomy.space.unbanAccount.v0": UnbanAccount,
  "space.roomy.space.createInvite.v0": CreateInvite,
  "space.roomy.space.revokeInvite.v0": RevokeInvite,
  "space.roomy.role.createRole.v0": CreateRole,
  "space.roomy.role.deleteRole.v0": DeleteRole,
  "space.roomy.role.updateRole.v0": UpdateRole,
  "space.roomy.role.addMemberRole.v0": AddMemberRole,
  "space.roomy.role.removeMemberRole.v0": RemoveMemberRole,
  "space.roomy.role.setRoleRoomPermission.v0": SetRoleRoomPermission,
  "space.roomy.federation.request.v0": FederationRequest,
  "space.roomy.federation.respond.v0": FederationRespond,
  "space.roomy.federation.remove.v0": FederationRemove,
  "space.roomy.federation.setRoomPermission.v0": SetRoomPermission,
  "space.roomy.federation.setReceiverPermission.v0": SetReceiverPermission,
  "space.roomy.voice.callStarted.v0": CallStarted,
  "space.roomy.voice.callJoined.v0": CallJoined,
  "space.roomy.voice.callLeft.v0": CallLeft,
  "space.roomy.voice.callEnded.v0": CallEnded,
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
