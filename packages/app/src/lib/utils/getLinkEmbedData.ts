import { dev } from "$app/environment";

export const cache = new Map<string, Embed | null>();

export const getLinkEmbedData = (url: string) => {
  let data = cache.get(url);
  if (data !== undefined) return data;

  return fetch(dev ? "/api/og" : "https://embed.internal.weird.one?lang=en", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
    },
    body: url,
  })
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as [Embed["ts"], Embed];
        cache.set(url, data[1]);
        return data[1];
      } else {
        console.error(
          `${res.status} Error finding data for url ${url}:  ${res.statusText}`,
        );
        // Embed server has no data for the given url.
        // Unlikely to be any data in the future
        cache.set(url, null);
        return null
      }
    })
    .catch((err) => {
      if (err instanceof TypeError) {
        console.error(`${err.message} caused by '${err.cause}'`);
        // Avoid retrying urls with Network Errors until next refresh
        // Might have data later.
      }
      console.error(err)
      return undefined
    });
};

/* from Lantern-chat/embed-sdk https://github.com/Lantern-chat/embed-service/blob/7ae895a7d41c17e7cee72bbe7aab1d5b8650d047/embed-sdk/index.d.ts */

type Timestamp = string;

export type EmbedType = "img" | "audio" | "vid" | "html" | "link" | "article";

/** Bitflags for EmbedFlags */
export const enum EmbedFlags {
  /** This embed contains spoilered content and should be displayed as such */
  SPOILER = 0x1,
  /**
   * This embed may contain content marked as "adult"
   *
   * NOTE: This is not always accurate, and is provided on a best-effort basis
   */
  ADULT = 0x2,
  /**
   * This embed contains graphics content such as violence or gore
   *
   * NOTE: This is not always accurate, and is provided on a best-effort basis
   */
  GRAPHIC = 0x4,
  /** All bitflags of EmbedFlags */
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
 * An embed is metadata taken from a given URL by loading said URL, parsing any meta tags, and fetching
 * extra information from oEmbed sources.
 */
export interface EmbedV1 {
  /** Timestamp when the embed was retrieved */
  ts: Timestamp;
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
   * See: <https://www.html5rocks.com/en/tutorials/security/sandboxed-iframes/>
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