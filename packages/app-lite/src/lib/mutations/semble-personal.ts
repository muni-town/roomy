import {
  buildCosmikCardRecord,
  COSMIK_CARD_COLLECTION,
  type CreatedCard,
  type schemas,
} from "@roomy-space/sdk";
import { auth } from "$lib/auth.svelte";
import { cosmikMetadataFromEmbed } from "./semble-card-metadata";

type LinkEmbedData = typeof schemas.queries.getMessage.LinkEmbedData.infer;

/**
 * Save a link to the USER'S OWN Semble collection as a `network.cosmik.card`.
 *
 * This is the personal half of the Semble integration. The space half
 * (`createSpaceCard`) writes through the space's arbiter to the space's
 * stewarded account; this writes to the caller's own PDS, as the caller, with
 * their own credentials — no arbiter, no proxy header. The record body is the
 * same either way (`buildCosmikCardRecord`), so a card is identical wherever
 * it lands; what differs is whose repo and whose authority.
 *
 * The caller's OAuth session must carry `repo:network.cosmik.card?action=create`
 * (the `semble` tier). A session that lacks it is refused by the PDS, and the
 * caller is expected to run this through `guardedXrpc` so that refusal becomes
 * a consent prompt rather than an opaque failure — which is why this write is
 * the tier's first real exercise.
 */
export async function saveToPersonalCollection(link: {
  url: string;
  embed?: LinkEmbedData | null;
}): Promise<CreatedCard> {
  const agent = auth.agent;
  if (!agent) throw new Error("Not authenticated");
  const resp = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection: COSMIK_CARD_COLLECTION,
    record: buildCosmikCardRecord({
      url: link.url,
      metadata: cosmikMetadataFromEmbed(link.embed),
    }),
  });
  return { uri: resp.data.uri, cid: resp.data.cid };
}
