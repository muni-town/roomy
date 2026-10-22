/**
 * Schema for `space.roomy.space.getActivityFeed` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getActivityFeed.ts
 */
import { type } from "arktype";
import { AttachmentDto, Media, LinkEmbed, Reaction } from "./_message";

export const NSID = "space.roomy.space.getActivityFeed" as const;

export const Params = type({
  "spaceId?": "string",
  "limit?": "string",
  "cursor?": "string",
});

export const ActivityAuthor = type({
  did: "string",
  "name?": "string",
  "handle?": "string",
  "avatar?": "string",
});

export const ActivityMessage = type({
  id: "string",
  content: "string",
  /**
   * MIME type of the content blob. `text/markdown` for legacy messages,
   * `application/vnd.roomy.richtext+json` for blocks+facets messages.
   */
  "mimeType?": "string",
  author: ActivityAuthor,
  "timestamp?": "string",
  /**
   * Every attachment on the message, one entry per row, discriminated by
   * `$type` — the same shape `room.getMessages` returns. Only hydrated on the
   * latest message of each feed item, like the derived views below.
   */
  "attachments?": AttachmentDto.array(),
  /** Media attachments (images/video/files). Derived from `attachments`; only hydrated on the latest message of each feed item. */
  "media?": Media.array(),
  /** Link embeds with enriched metadata. Derived from `attachments`; only hydrated on the latest message of each feed item. */
  "linkEmbeds?": LinkEmbed.array(),
  /** Reactions on the message. Only hydrated on the latest message of each feed item. */
  "reactions?": Reaction.array(),
});

export const ActivityItem = type({
  threadId: "string",
  "threadName?": "string",
  spaceId: "string",
  "spaceName?": "string",
  "spaceAvatar?": "string",
  "channelId?": "string",
  "channelName?": "string",
  lastActivityAt: "string",
  activityType: "'message'",
  messages: ActivityMessage.array(),
  unreadCount: "number",
});

export const Response = type({
  feed: ActivityItem.array(),
  "cursor?": "string",
});