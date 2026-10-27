/**
 * Schema for `space.roomy.room.getLinks` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.room.getLinks.ts
 *
 * Paginated, newest-first, URL-deduped index of every link shared in a single
 * room, filtered by the caller's read access.
 */
import { type } from "arktype";
import { LinkEmbedData } from "./_message";

export const NSID = "space.roomy.room.getLinks" as const;

export const Params = type({
  roomId: "string",
  "limit?": "string",
  "cursor?": "string",
});

export { LinkEmbedData };

export const Link = type({
  url: "string",
  /** The room the link was shared in (the real room id, not the message id). */
  roomId: "string",
  /** The message that shared the link. */
  messageId: "string",
  /** When the link was shared (ISO 8601 UTC), absent when not derivable. */
  "timestamp?": "string",
  /** Enriched card data (EmbedV1), absent when the enricher had no data. */
  "embed?": LinkEmbedData,
});

export const Response = type({
  links: Link.array(),
  "cursor?": "string",
});
