/**
 * Presentation model for the links view (`LinkView`).
 *
 * Mirrors the wire `Link` from `space.roomy.room.getLinks` /
 * `space.roomy.space.getLinks`, reduced to what a card renders. `url` is the
 * record identity (the server index is URL-deduped); `roomId` / `messageId`
 * are not carried because a card opens the link itself, not the message that
 * shared it.
 */
export type LinkInfo = {
  url: string;
  /**
   * When the containing message was posted, as an ISO 8601 string — the
   * ordering key the server sorts the index by. Absent on older servers (or
   * an undecodable key), in which case the card simply shows no date.
   */
  timestamp?: string;
  /** Enriched card from the embed service; absent when it had no data. */
  embed?: LinkEmbedInfo;
};

/** The oEmbed/OpenGraph fields the card knows how to render. */
export type LinkEmbedInfo = {
  /** oEmbed title, else OG `og:title` / `<title>`. */
  title?: string;
  /** oEmbed description, else OG `og:description` / `<meta name="description">`. */
  description?: string;
  /** First OG image; the mapper falls back to the OG thumbnail. */
  image?: string;
  /** Direct video URL (OG video or an oEmbed iframe `src`). */
  video?: string;
  /** OG thumbnail, used as the video poster. */
  thumbnail?: string;
  /** oEmbed `provider_name` (or OG `og:site_name`). */
  provider?: string;
  /** oEmbed `author_name`. */
  author?: string;
};
