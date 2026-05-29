/**
 * Schema for `space.roomy.room.getMetadata` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getMetadata.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getMetadata" as const;

export const Params = type({ roomId: "string" });

export const RecentThread = type({
  id: "string",
  "name?": "string",
  canRead: "boolean",
  canWrite: "boolean",
  unreadCount: "number",
  "lastRead?": "string",
});

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
  recentThreads: RecentThread.array(),
});
