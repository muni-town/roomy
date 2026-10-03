import type { CosmikCardMetadata, schemas } from "@roomy-space/sdk";

type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

/**
 * Map a message's enriched link embed onto the Semble card's `#urlMetadata`.
 *
 * Shared by both Semble write paths so a card carries the same metadata
 * whichever repo it lands in. Returns `null` when the message had no embed —
 * the card then records only the URL.
 */
export function cosmikMetadataFromEmbed(
  embed: LinkEmbedData | null | undefined,
): CosmikCardMetadata | null {
  if (!embed) return null;
  // Same image preference the LinkCard renderer uses: first embed image, else
  // the thumbnail.
  const imageUrl =
    embed.imgs && embed.imgs.length > 0 ? embed.imgs[0]?.u : embed.thumb?.u;
  return {
    title: embed.t,
    description: embed.d,
    author: embed.au?.n,
    siteName: embed.p?.n,
    imageUrl,
    retrievedAt: new Date().toISOString(),
  };
}
