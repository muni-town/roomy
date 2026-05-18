/**
 * Schema for `space.roomy.room.getMetadata` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getMetadata.ts
 *
 * Note: appserver returns `name: string | null` for both the room and each
 * recentThread (info row may be missing); playground's hand-authored types had
 * non-null. We follow the appserver.
 */
import { type } from "arktype";

export const NSID = "space.roomy.room.getMetadata" as const;

export const Params = type({ roomId: "string" });

export const RecentThread = type({
  id: "string",
  name: "string | null",
  canRead: "boolean",
  canWrite: "boolean",
  unreadCount: "number",
  lastRead: "string | null",
});

export const Response = type({
  name: "string | null",
  kind: "string",
  spaceId: "string",
  defaultAccess: "'readwrite' | 'read' | 'none'",
  canRead: "boolean",
  canWrite: "boolean",
  lastRead: "string | null",
  unreadCount: "number",
  recentThreads: RecentThread.array(),
});
