// Types for 'archetypes' - domain entities that canonically must have certain components, but that aren't one-to-one with specific 'entity labels'

import type { ComponentsRecord } from "./components";
import type { EdgesRecord } from "./edges";

// IMAGE
export type Image = ComponentsRecord<["url", "media"], ["description"]>;

// THREAD
// label: timeline
// Edges:
// - member <- space
// - avatar -> image
// - child -> message
// - child -> thread (subthread)
// - pin -> message
export type Thread = ComponentsRecord<["name"], ["description", "identifier"]> &
  EdgesRecord<["member", "avatar", "child", "pin"]>;

// PAGE
// label: timeline
// Edges
// - child -> message
export type Page = ComponentsRecord<["page", "name", "description"]> &
  EdgesRecord<["child"]>;

// FOLDER
// label: null
// Edges:
// - child -> timeline
export type Folder = ComponentsRecord<["name"]> & EdgesRecord<["child"]>;

// INBOX
// label: timeline
// Edges:
// - child -> notification
export type Inbox = EdgesRecord<["child"]>;

// UPLOAD
// label: task
// I think if a message is waiting on an upload, it can 'embed' the entity, which can have a 'source' edge pointing to
export type Upload = ComponentsRecord<["upload"]>;
