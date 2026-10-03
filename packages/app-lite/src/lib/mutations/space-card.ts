import {
  createCosmikCard,
  type CreatedCard,
  type schemas,
} from "@roomy-space/sdk";
import { createArbiterClient } from "$lib/arbiter";
import { cosmikMetadataFromEmbed } from "./semble-card-metadata";

type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

/**
 * Create a Semble space card (`network.cosmik.card`) on the space's own
 * ATProto account from a chat-message link.
 *
 * Goes directly to the space's arbiter through the
 * `space.roomy.authComplete.arbiter.proxy` procedure — the same admin-authority
 * path as the Bluesky profile integration (see `createArbiterClient`). The
 * published `space.roomy.authComplete` scope policy admits the proxied
 * `createRecord` for `network.cosmik.*` collections, and the space's policy
 * pipeline grants its Roomy admins.
 *
 * Only the link and its enriched metadata are recorded — the message text is
 * never copied into the card. The record body itself comes from the SDK
 * (`buildCosmikCardRecord`, shared with the personal-collection write); this
 * module supplies only the space's authority and the message's embed data.
 */
export async function createSpaceCard(
  spaceId: string,
  link: { url: string; embed?: LinkEmbedData | null },
): Promise<CreatedCard> {
  const arbiter = createArbiterClient();
  return createCosmikCard(arbiter, spaceId, {
    url: link.url,
    metadata: cosmikMetadataFromEmbed(link.embed),
  });
}