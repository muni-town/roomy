/**
 * Schema for `space.roomy.space.getThreads` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getThreads.ts
 *
 * Despite the NSID, this powers the space index board and returns ALL rooms
 * (channels + threads), not just threads. The name is historical; the NSID
 * is part of the OAuth consent scope and invalidation wiring, so it stays.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getThreads" as const;

export const Params = type({
  spaceId: "string",
  "limit?": "string",
  "cursor?": "string",
  /** Optional case-insensitive substring filter on room name. */
  "search?": "string",
});

export const ThreadMember = type({
  did: "string",
  "name?": "string | null",
  "avatar?": "string | null",
});


export const ThreadMessage = type({
  id: "string",
  content: "string",
  author: ThreadMember,
  "timestamp?": "string",
});

export const ThreadActivity = type({
  "latestTimestamp?": "string",
  latestMembers: ThreadMember.array(),
  "latestMessage?": ThreadMessage,
});

export const Room = type({
  id: "string",
  /** `thread` (canonically linked from a channel) or `channel`. */
  kind: "'thread' | 'channel'",
  "name?": "string",
  /** Parent channel ID (threads only). */
  "channel?": "string",
  /** Parent channel name (threads only). */
  "channelName?": "string",
  "unreadCount?": "number",
  /**
   * Honest unread flag for the board: true when the room has messages the
   * user hasn't read. For threads this includes never-engaged threads (no
   * read_positions row yet); for channels it's `unreadCount > 0`, matching
   * the sidebar's per-channel unread counts.
   */
  "unread?": "boolean",
  activity: ThreadActivity,
});

export const Response = type({
  rooms: Room.array(),
  "cursor?": "string",
});
