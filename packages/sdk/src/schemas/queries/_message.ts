/**
 * Shared Message schema, used by both `room.getMessages` and
 * `message.getMessage` responses, and by the `#messageDiff` WS frame.
 * Mirrors packages/appserver/src/queries/selectMessages.ts MessageDto.
 */
import { type } from "arktype";

export const Reaction = type({
  emoji: "string",
  dids: "string[]",
  /** reaction_id of the viewer's own reaction for this emoji; absent when not reacted. */
  "myReactionId?": "string",
});

export const Media = type({
  url: "string",
  type: "string",
  "alt?": "string",
});

export const ForwardedFrom = type({
  name: "string",
  roomId: "string",
});

/**
 * A link embed with optional enriched metadata from the embed service.
 * The `embed` field contains the EmbedV1 JSON object when enrichment has
 * completed; it's absent/null when still pending or when the service had
 * no data for the URL.
 *
 * The embed data follows the Lantern-chat embed-service protocol:
 * https://github.com/Lantern-chat/embed-service
 */

/** Minimal media reference within an embed (image, video, thumbnail). */
const EmbedMedia = type({
  u: "string",
  "d?": "string",
  "w?": "number",
  "h?": "number",
  "m?": "string",
});

/** Provider info from oEmbed. */
const EmbedProvider = type({
  "n?": "string",
  "u?": "string",
});

/** Author info from OpenGraph. */
const EmbedAuthor = type({
  "n?": "string",
  "u?": "string",
});

/** Footer text. */
const EmbedFooter = type({
  "t?": "string",
});

/**
 * Enriched embed metadata (EmbedV1 from the embed service).
 * All fields are optional since enrichment may be partial or pending.
 */
export const LinkEmbedData = type({
  "t?": "string",
  "d?": "string",
  "p?": EmbedProvider,
  "au?": EmbedAuthor,
  "footer?": EmbedFooter,
  "imgs?": EmbedMedia.array(),
  "vid?": EmbedMedia,
  "thumb?": EmbedMedia,
});

export const LinkEmbed = type({
  url: "string",
  "embed?": LinkEmbedData,
});

export const Message = type({
  id: "string",
  /** Sort index for timeline ordering. ULID based on canonical timestamp. */
  "sort_idx?": "string",
  content: "string",
  authorDid: "string",
  authorName: "string",
  "authorHandle?": "string",
  "authorAvatar?": "string",
  timestamp: "string",
  "replyTo?": "string",
  "forwardedFrom?": ForwardedFrom,
  reactions: Reaction.array(),
  media: Media.array(),
  /** Link embeds with enriched metadata from the embed service. */
  linkEmbeds: LinkEmbed.array(),
});
