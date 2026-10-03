import type { ArbiterClient } from "./arbiter";

/**
 * Helpers for creating Semble cards (`network.cosmik.card`) on a space's
 * stewarded ATProto account.
 *
 * Writes go through the arbiter's `space.roomy.authComplete.arbiter.proxy`
 * procedure (see {@link ArbiterClient}). The published `space.roomy.authComplete`
 * permission-set scope policy admits proxied record writes whose collection is
 * `network.cosmik.*`, and the space's policy pipeline grants its Roomy admins.
 *
 * The record shape mirrors the published Semble card lexicon: a URL card
 * carries the bookmarked URL and optional fetched page metadata — nothing
 * else (no NOTE card, no surrounding chat-message text).
 */

/** The Semble card collection a space card is written to. */
export const COSMIK_CARD_COLLECTION = "network.cosmik.card";

/** Optional page metadata attached to a URL card (`#urlMetadata`). */
export interface CosmikCardMetadata {
  /** Content type (e.g. "article", "video"). */
  type?: string;
  /** Page title. */
  title?: string;
  /** Page description or excerpt. */
  description?: string;
  /** Content author. */
  author?: string;
  /** Site name. */
  siteName?: string;
  /** URL of a representative image. */
  imageUrl?: string;
  /** ISO 8601 datetime the content was published. */
  publishedDate?: string;
  /** ISO 8601 datetime the metadata was retrieved. */
  retrievedAt?: string;
}

/** The created card's AT-URI + CID (as returned by `createRecord`). */
export interface CreatedCard {
  uri: string;
  cid: string;
}

/** A URL card to write: the bookmarked link plus optional page metadata. */
export interface CosmikUrlCard {
  url: string;
  metadata?: CosmikCardMetadata | null;
}

/**
 * Build the `network.cosmik.card` record body for a URL card.
 *
 * Shared by both write paths — the space's stewarded account through the
 * arbiter, and the user's own repo — so a card is the same record wherever it
 * lands. Only the link and its metadata are recorded: no note text, no
 * surrounding chat-message content.
 */
export function buildCosmikCardRecord(card: CosmikUrlCard): Record<string, unknown> {
  // Drop unset metadata fields (undefined values don't survive the JSON wire
  // anyway, but an all-undefined metadata object should be omitted entirely).
  const metadataEntries = card.metadata
    ? Object.entries(card.metadata).filter(([, v]) => v !== undefined)
    : [];
  const metadata =
    metadataEntries.length > 0
      ? {
          $type: `${COSMIK_CARD_COLLECTION}#urlMetadata`,
          ...Object.fromEntries(metadataEntries),
        }
      : undefined;

  return {
    $type: COSMIK_CARD_COLLECTION,
    type: "URL",
    content: {
      $type: `${COSMIK_CARD_COLLECTION}#urlContent`,
      url: card.url,
      ...(metadata ? { metadata } : {}),
    },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a URL card (`network.cosmik.card`) on the space's stewarded account
 * via the arbiter proxy: only the link and its metadata are recorded.
 *
 * The record key is assigned by the PDS (the lexicon's `key: tid`), so
 * creating a card for the same URL twice yields two distinct cards.
 */
export async function createCosmikCard(
  arbiter: ArbiterClient,
  spaceDid: string,
  card: CosmikUrlCard,
): Promise<CreatedCard> {
  const record = buildCosmikCardRecord(card);

  const resp = await arbiter.proxy(spaceDid, {
    nsid: "com.atproto.repo.createRecord",
    method: "POST",
    body: {
      repo: spaceDid,
      collection: COSMIK_CARD_COLLECTION,
      record,
    },
  });
  const uri = typeof resp.uri === "string" ? resp.uri : undefined;
  const cid = typeof resp.cid === "string" ? resp.cid : undefined;
  if (!uri || !cid) {
    throw new Error("Arbiter createRecord response missing uri/cid");
  }
  return { uri, cid };
}