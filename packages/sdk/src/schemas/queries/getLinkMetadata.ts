/**
 * Schema for `space.roomy.embed.getLinkMetadata` (query).
 *
 * Enriches a URL with link metadata (OpenGraph + oEmbed discovery) served by
 * the appserver. Returns the same `LinkEmbedData` shape used on message link
 * embeds, so the client's `LinkCard` can render the result unchanged.
 *
 * All fields optional — a URL may yield partial data or none at all.
 */
import { type } from "arktype";

export const NSID = "space.roomy.embed.getLinkMetadata" as const;

export const Params = type({
  /** The http(s) URL to enrich. */
  url: "string",
});

/** Minimal media reference within an embed (image, video, thumbnail). */
export const EmbedMedia = type({
  u: "string",
  "d?": "string",
  "w?": "number",
  "h?": "number",
  "m?": "string",
});

/** Provider info (from oEmbed / og:site_name). */
export const EmbedProvider = type({
  "n?": "string",
  "u?": "string",
});

/** Author info. */
export const EmbedAuthor = type({
  "n?": "string",
  "u?": "string",
});

/** Enriched link metadata (same shape as message LinkEmbedData). */
export const LinkEmbedData = type({
  "t?": "string",
  "d?": "string",
  "p?": EmbedProvider,
  "au?": EmbedAuthor,
  "footer?": type({ "t?": "string" }),
  "imgs?": EmbedMedia.array(),
  "vid?": EmbedMedia,
  "thumb?": EmbedMedia,
});

export const Response = LinkEmbedData;
