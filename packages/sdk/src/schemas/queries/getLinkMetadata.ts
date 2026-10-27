/**
 * Schema for `space.roomy.embed.getLinkMetadata` (query).
 *
 * Enriches a URL with link metadata (OpenGraph + oEmbed discovery) served by
 * the appserver. Returns the same `LinkEmbedData` shape used on message link
 * embeds, so the client's `LinkCard` can render the result unchanged — one
 * definition, so the two cannot drift.
 *
 * All fields optional — a URL may yield partial data or none at all.
 */
import { type } from "arktype";
import { LinkEmbedData } from "./_message";

export const NSID = "space.roomy.embed.getLinkMetadata" as const;

export const Params = type({
  /** The http(s) URL to enrich. */
  url: "string",
});

export { LinkEmbedData };

export const Response = LinkEmbedData;
