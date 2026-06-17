/**
 * Embed types matching the Lantern-chat embed-service protocol.
 *
 * The embed service (embed.internal.weird.one) accepts a URL via POST and
 * returns a 2-element JSON array: `[timestamp, EmbedV1]`.
 *
 * Ported from packages/app/src/lib/utils/getLinkEmbedData.ts
 * Source: https://github.com/Lantern-chat/embed-service
 */

export type EmbedType = "img" | "audio" | "vid" | "html" | "link" | "article";

/** Bitflags for EmbedFlags */
export const enum EmbedFlags {
  SPOILER = 0x1,
  ADULT = 0x2,
  GRAPHIC = 0x4,
  ALL = 0x7,
}

export interface BasicEmbedMedia {
  u: string;
  /** Non-visible description of the embedded media */
  d?: string;
  /** Cryptographic signature for use with the proxy server */
  s?: string;
  /** height */
  h?: number;
  /** width */
  w?: number;
  m?: string;
}

export interface EmbedMedia extends BasicEmbedMedia {
  a?: BasicEmbedMedia[];
}

export interface EmbedAuthor {
  n: string;
  u?: string;
  i?: EmbedMedia;
}

export interface EmbedProvider {
  n?: string;
  u?: string;
  i?: EmbedMedia;
}

export interface EmbedField {
  n?: string;
  v?: string;
  img?: EmbedMedia;
  /** Should use block-formatting */
  b?: boolean;
}

export interface EmbedFooter {
  t: string;
  i?: EmbedMedia;
}

/**
 * An embed is metadata taken from a given URL by loading said URL, parsing
 * any meta tags, and fetching extra information from oEmbed sources.
 */
export interface EmbedV1 {
  /** Timestamp when the embed was retrieved */
  ts: string;
  /** Embed type */
  ty: EmbedType;
  f?: EmbedFlags;
  /** URL fetched */
  u?: string;
  /** Canonical URL */
  c?: string;
  t?: string;
  /** Description, usually from the Open-Graph API */
  d?: string;
  /** Accent Color */
  ac?: number;
  au?: EmbedAuthor;
  /** oEmbed Provider */
  p?: EmbedProvider;
  /**
   * HTML and similar objects
   *
   * See: https://www.html5rocks.com/en/tutorials/security/sandboxed-iframes/
   */
  obj?: EmbedMedia;
  /** Contains images for the embed */
  imgs?: EmbedMedia[];
  audio?: EmbedMedia;
  vid?: EmbedMedia;
  thumb?: EmbedMedia;
  fields?: EmbedField[];
  footer?: EmbedFooter;
}

export type Embed = { v: "1" } & EmbedV1;

/**
 * The embed service returns `[timestamp, EmbedV1]` as a JSON array.
 */
export type EmbedServiceResponse = [string, Embed];
