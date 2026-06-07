/**
 * Schema for `space.roomy.space.getActivityFeed` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getActivityFeed.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getActivityFeed" as const;

export const Params = type({
  "spaceId?": "string",
  "limit?": "string",
  "cursor?": "string",
});

export const ActivityAuthor = type({
  did: "string",
  "name?": "string",
  "avatar?": "string",
});

export const ActivityMessage = type({
  id: "string",
  content: "string",
  author: ActivityAuthor,
  "timestamp?": "string",
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