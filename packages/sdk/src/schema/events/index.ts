import { type, Type } from "arktype";
import { decodeTime } from "ulidx";
import { Ulid, StreamDid, UserDid, fromBytes } from "../primitives";
import type { EdgesMap, EdgesWithPayload, SqlStatement } from "../../types";

// Re-export types and utilities for materializers
export type { SqlStatement };
import { sql } from "../../utils/sqlTemplate";
export { sql, decodeTime, fromBytes };

/** Envelope fields added to all events */
export interface EventEnvelope {
  id: typeof Ulid.infer;
  room?: typeof Ulid.infer;
}

/** Context passed to materializer functions */
export interface MaterializeContext<T extends { $type: string }> {
  streamId: typeof StreamDid.infer;
  user: typeof UserDid.infer;
  event: Event<T["$type"]>;
}

/** Materializer function type */
export type MaterializeFn<T extends { $type: string }> = (
  ctx: MaterializeContext<T>,
) => SqlStatement[];

/** DependsOn function type - returns IDs that define causal dependencies */
export type DependsOnFn<T> = (
  event: T & EventEnvelope,
) => (typeof Ulid.infer)[];

/** Type for a defined event with materialize and optional dependsOn */
export type DefinedEvent<
  TSchema extends Type<{ $type: string }>,
  HasDependsOn extends boolean = false,
> = {
  schema: TSchema;
  materialize: MaterializeFn<TSchema["infer"]>;
  dependsOn: HasDependsOn extends true
    ? DependsOnFn<TSchema["infer"]>
    : undefined;
  create: (
    id: Ulid,
    data: TSchema["infer"] & { room?: Ulid },
  ) => Event<TSchema["infer"]["$type"]>;
};

/**
 * Define an event schema with materialize and dependsOn functions.
 */
export function defineEvent<TSchema extends Type<{ $type: string }>>(
  schema: TSchema,
  materialize: MaterializeFn<TSchema["infer"]>,
  dependsOn: DependsOnFn<TSchema["infer"]>,
): DefinedEvent<TSchema, true>;

/**
 * Define an event schema with only a materialize function.
 */
export function defineEvent<TSchema extends Type<{ $type: string }>>(
  schema: TSchema,
  materialize: MaterializeFn<TSchema["infer"]>,
): DefinedEvent<TSchema, false>;

export function defineEvent<TSchema extends Type<{ $type: string }>>(
  schema: TSchema,
  materialize: MaterializeFn<TSchema["infer"]>,
  dependsOn?: DependsOnFn<TSchema["infer"]>,
): DefinedEvent<TSchema, boolean> {
  return {
    schema,
    materialize,
    dependsOn,
  } as DefinedEvent<TSchema, boolean>;
}

/** Helper to create typed edge payloads */
export function edgePayload<EdgeLabelKey extends keyof EdgesWithPayload>(
  payload: EdgesMap[EdgeLabelKey],
): string {
  return JSON.stringify(payload);
}

/** Helper to ensure an entity exists in the database */
export function ensureEntity(
  streamId: string,
  entityId: string,
  room?: string,
): SqlStatement {
  let unixTimeMs = Date.now();

  try {
    // Try to decode timestamp from ULID
    unixTimeMs = decodeTime(entityId);
  } catch (_) {}

  return sql`
    insert into entities (id, stream_id, room, created_at)
    values (
      ${entityId},
      ${streamId},
      ${room ? room : undefined},
      ${unixTimeMs}
    )
    on conflict(id) do update set
      room = coalesce(entities.room, excluded.room),
      updated_at = case
        when entities.room is null and excluded.room is not null
        then excluded.updated_at
        else entities.updated_at
      end
  `;
}

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
  UpdateSidebar,
  AddAdmin,
  RemoveAdmin,
  SetHandleAccount,
} from "./space";
export { EditPage } from "./page";
export { SetUserProfile, OverrideUserHandle, SetLastRead } from "./user";
export { CreateRoomLink, RemoveRoomLink } from "./link";

// Import defined events for the registry
import {
  CreateMessage,
  EditMessage,
  DeleteMessage,
  MoveMessages,
  ReorderMessage,
} from "./message";
import { CreateRoom, UpdateRoom, DeleteRoom } from "./room";
import {
  AddReaction,
  RemoveReaction,
  AddBridgedReaction,
  RemoveBridgedReaction,
} from "./reaction";
import {
  JoinSpace,
  LeaveSpace,
  PersonalJoinSpace,
  PersonalLeaveSpace,
  UpdateSpaceInfo,
  UpdateSidebar,
  AddAdmin,
  RemoveAdmin,
  SetHandleAccount,
} from "./space";
import { EditPage } from "./page";
import { SetUserProfile, OverrideUserHandle, SetLastRead } from "./user";
import { CreateRoomLink, RemoveRoomLink } from "./link";
import { Event, EventType } from "../envelope";

/** Registry of all defined events by their $type */
const eventRegistry = {
  "space.roomy.message.createMessage.v0": CreateMessage,
  "space.roomy.message.editMessage.v0": EditMessage,
  "space.roomy.message.deleteMessage.v0": DeleteMessage,
  "space.roomy.message.moveMessages.v0": MoveMessages,
  "space.roomy.message.reorderMessage.v0": ReorderMessage,
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
  "space.roomy.space.updateSidebar.v0": UpdateSidebar,
  "space.roomy.space.addAdmin.v0": AddAdmin,
  "space.roomy.space.removeAdmin.v0": RemoveAdmin,
  "space.roomy.space.setHandleAccount.v0": SetHandleAccount,
  "space.roomy.page.editPage.v0": EditPage,
  "space.roomy.user.updateProfile.v0": SetUserProfile,
  "space.roomy.user.overrideHandle.v0": OverrideUserHandle,
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

type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends object ? DeepMutable<T[K]> : T[K];
};

/** Get the materializer for an event type */
export function getMaterializer<T extends EventType>(eventType: T) {
  return eventRegistry[eventType]?.materialize as unknown as MaterializeFn<
    Event<T>
  >;
}
