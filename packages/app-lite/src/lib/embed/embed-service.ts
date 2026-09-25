/**
 * Client-side link-embed enrichment.
 *
 * The composer reaches out to the **appserver's** `space.roomy.embed.getLinkMetadata`
 * XRPC query to enrich a URL into link metadata for a pre-send preview.
 * Enrichment lives in the appserver (OpenGraph + oEmbed discovery), so it's
 * authenticated and CORS-free, and it's the seam where ATProto-native
 * enrichment (DID resolution, HappyView, PDS fetches) will later be layered in.
 *
 * The endpoint returns the SDK's `LinkEmbedData` shape, which the existing
 * `LinkCard` component renders unchanged.
 */

import type { schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";

export type LinkEmbedData =
  typeof schemas.queries.getLinkMetadata.LinkEmbedData.infer;

/**
 * Regex to detect URLs in plain-text content (the legacy markdown path).
 * Matches common URL patterns including protocol-relative and wrapped in
 * angle brackets. Skips trailing punctuation that's not part of the URL.
 */
const URL_REGEX =
  /<?(https?:\/\/)[a-z0-9][-a-z0-9]*\.[a-z]{2,}[^\s<>]*[a-zA-Z0-9\/]>?/gi;

/**
 * Extract unique, valid HTTP(S) URLs from a string of text.
 * Strips surrounding angle brackets and trailing punctuation.
 */
export function extractUrls(text: string): string[] {
  const matches = text.matchAll(URL_REGEX);
  const urls = new Set<string>();
  for (const match of matches) {
    let url = match[0];
    if (url.startsWith("<") && url.endsWith(">")) {
      url = url.slice(1, -1);
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    urls.add(url);
  }
  return [...urls];
}

/**
 * Fetch link metadata for a single URL from the appserver's
 * `space.roomy.embed.getLinkMetadata` XRPC query.
 *
 * Best-effort: returns `null` on any failure (missing auth, network error,
 * or an empty response for a URL with no metadata) so the composer degrades
 * gracefully to a URL-only preview. Never throws.
 */
export async function fetchEmbedData(url: string): Promise<LinkEmbedData | null> {
  try {
    const data = await px().query("space.roomy.embed.getLinkMetadata", { url });
    // The endpoint returns an empty object when the URL has no metadata.
    if (!data || Object.keys(data).length === 0) return null;
    return data as LinkEmbedData;
  } catch {
    return null;
  }
}
