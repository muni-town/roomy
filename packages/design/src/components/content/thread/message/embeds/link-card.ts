/**
 * Which card a link embed draws.
 *
 * A link can carry two renders of the same URL: a Web Tile resolved from the
 * record behind it, and the OpenGraph metadata the page itself served. The tile
 * is the better card when it works — it draws the post rather than the page's
 * preamble — but it is loaded at render time from a third-party loading server
 * and the publisher's PDS, either of which can be down, and the OpenGraph card
 * is then the difference between a reader seeing the link and seeing an error
 * box. So the choice is a fallback, not a preference: a tile that cannot load
 * yields to the metadata that is already in hand.
 *
 * Kept pure so the rule is testable without mounting either component.
 */

/** The tile half of a `LinkEmbedData`, as the projection carries it. */
export interface EmbedTileRef {
  /** The tile record's bare AT-URI. */
  url: string;
  /** The JSON handed to the tile on load; absent when the resolver had none. */
  data?: unknown;
}

export interface LinkCardChoice {
  /** The tile to mount, or undefined to draw the OpenGraph card instead. */
  tile: EmbedTileRef | undefined;
  /** Whether the OpenGraph body has anything to draw. */
  hasMetadata: boolean;
}

/** The metadata fields a card can render; absent ones are simply skipped. */
export interface LinkCardMetadata {
  t?: string;
  d?: string;
  p?: { n?: string };
  au?: { n?: string };
  footer?: { t?: string };
  imgs?: readonly unknown[];
  vid?: unknown;
  thumb?: unknown;
  tile?: EmbedTileRef;
}

/**
 * Pick the card for one link.
 *
 * `tileAllowed` is the host's switch — a feature flag, or the shared per-message
 * tile cap — and `tileFailed` is the tile having tried and not loaded. Either
 * one being false/true falls back to the metadata card; with no metadata
 * either, the caller shows the bare URL.
 */
export function chooseLinkCard(
  embed: LinkCardMetadata | null | undefined,
  opts: { tileAllowed: boolean; tileFailed: boolean },
): LinkCardChoice {
  const metadata = hasMetadata(embed);
  const tile =
    opts.tileAllowed && !opts.tileFailed && embed?.tile ? embed.tile : undefined;
  return { tile, hasMetadata: metadata };
}

/** Whether an embed carries anything the OpenGraph card can draw. */
export function hasMetadata(embed: LinkCardMetadata | null | undefined): boolean {
  if (!embed) return false;
  return Boolean(
    embed.t ||
      embed.d ||
      embed.p?.n ||
      embed.au?.n ||
      embed.footer?.t ||
      embed.imgs?.length ||
      embed.vid ||
      embed.thumb,
  );
}
