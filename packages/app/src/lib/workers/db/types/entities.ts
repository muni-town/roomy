// The entity label is a shortcut for identifying what an entity may be, but it is more critically determined by the attached components

import type { ComponentsRecord } from "./components";
import type { EdgesRecord } from "./edges";

export type EntityId = string; // ULID

export type EntityLabel =
  | "notification"
  | "media"
  | "device"
  | "user"
  | "timeline"
  | "message"
  | "task"
  | "space"
  | null;

// USER
// Edges:
// - avatar -> image
// - subscribe -> thread
// - child -> device
export type User = ComponentsRecord<
  ["name", "description", "identifier", "profile", "config"]
> &
  EdgesRecord<["avatar", "subscribe", "child"]>;

// SPACE
// Edges:
// - member -> user
// - avatar -> image
// - child -> thread / page / folder
// - ban -> user
export type Space = ComponentsRecord<["name", "description", "identifier"]> &
  EdgesRecord<["member", "avatar", "child", "ban"]>;

// MESSAGE
// Edges:
// - reply -> message
// - author -> user
// - embed -> media
// - reorder -> message (reorder points to the message this one should go after in the thread)
// - reaction -> user (reaction data on edge)
// - link -> thread (for when a thread starts from a message), other things
export type Message = ComponentsRecord<
  ["text_content"],
  ["user_access_times"]
> &
  EdgesRecord<["reply", "author", "embed", "reorder", "reaction", "link"]>;

// EMBED
// Edges:
// - source -> upload
export type Embed = (
  | ComponentsRecord<["media"], ["description"]>
  | ComponentsRecord<["url"], ["description"]>
) &
  EdgesRecord<["source"]>;

// NOTIFICATION
// Components:
// - ?
// Edges:
// - link -> thread / page / folder
export type Notification = EdgesRecord<["link"]>;

// TASK
// See 'UPLOAD' in ./archetypes.ts

// DEVICE
// Components:
// - identifier

export type Device = ComponentsRecord<["identifier"]>;
