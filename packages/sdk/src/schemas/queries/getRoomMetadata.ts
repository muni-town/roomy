/**
 * Schema for `space.roomy.room.getMetadata` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getMetadata.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getMetadata" as const;

export const Params = type({ roomId: "string" });

export const Response = type({
  "name?": "string",
  kind: "string",
  spaceId: "string",
  "parentChannelId?": "string",
  defaultAccess: "'readwrite' | 'read' | 'none'",
  canRead: "boolean",
  canWrite: "boolean",
  "lastRead?": "string",
  unreadCount: "number",
  /** Number of threads in this channel with unread messages (engaged only). */
  unreadThreadCount: "number",
});
