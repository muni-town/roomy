/**
 * Schema for `space.roomy.search.messages` (query).
 *
 * Full-text message search backed by Qdrant, filtered by the caller's read
 * access. With `spaceId` the search is scoped to one space; without it the
 * search spans every space the caller has joined (cross-space). Returns
 * messages hydrated via selectMessages so the response shape matches the
 * shared Message schema, plus `roomId`/`spaceId` so cross-space results can
 * be linked back to their source room, and the resolved display names
 * (`spaceName`/`spaceAvatar`/`roomName`/`roomKind`) so the result context
 * line renders without extra summary queries. Each hit carries a
 * denormalised `reply` (the replied-to message, fully hydrated) when it is
 * resolvable and the caller may read its room — search results render in a
 * chat-style list, so the preview rides along instead of costing the client
 * a getMessage fetch per hit.
 */
import { scope, type } from "arktype";
import { Message } from "./_message";

export const NSID = "space.roomy.search.messages" as const;

export const Params = type({
  /** Narrow the search to one space. Omitted → search the caller's joined spaces. */
  "spaceId?": "string",
  /** Search query. Must be at least 3 characters. */
  q: "string",
  "limit?": "string",
  "cursor?": "string",
});

/**
 * Denormalised reply context for a search hit. The replied-to message is
 * embedded here fully hydrated (mirroring `forwardedFrom.message`) so the
 * client renders the preview with no extra fetch. The appserver attaches it
 * only when the target resolves and the caller has read access to the
 * target's room; it is absent otherwise.
 */
export const Reply = type({
  messageId: "string",
  "message?": Message,
});

/**
 * A search hit: the shared Message shape plus the room/space it lives in.
 * The appserver hydrates via selectMessages and annotates each result with
 * its source room and space so the client can deep-link into the room.
 */
export const SearchMessage = Message.and({
  roomId: "string",
  spaceId: "string",
  "reply?": Reply,
  "spaceName?": "string",
  "spaceAvatar?": "string",
  "roomName?": "string",
  "roomKind?": "string",
});

export const Response = type({
  messages: SearchMessage.array(),
  "cursor?": "string",
});
