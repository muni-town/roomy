/**
 * DIY link-metadata enrichment: OpenGraph + oEmbed.
 *
 * Fetches a URL's HTML and extracts metadata using the standard unfurl
 * pipeline:
 *
 *   1. **oEmbed discovery** — parse the page for a `<link rel="alternate"
 *      type="application/json+oembed">` endpoint and call it. This is the
 *      sanctioned API for providers that advertise one (YouTube, Reddit,
 *      Twitter/X, Instagram, Spotify, …) and returns clean structured data
 *      rather than raw HTML scraping.
 *   2. **OpenGraph fallback** — parse `og:`/`twitter:` meta tags (plus
 *      `<title>`/`meta[name=description]`) when no oEmbed endpoint exists
 *      or oEmbed returns nothing.
 *
 * Best-effort and non-blocking: any failure (timeout, non-OK, bot-blocked
 * 403/404, unparseable HTML) returns `null` and the caller degrades to a
 * URL-only link. This is deliberately self-contained (no external scraper
 * dependency) so ATProto-native enrichment can later be layered on top of
 * the same endpoint without changing the interface.
 *
 * The returned shape mirrors the SDK's `LinkEmbedData` (a subset of the
 * Lantern EmbedV1 protocol) so existing `LinkCard` rendering works as-is.
 */

// ─── Configuration ──────────────────────────────────────────────────────

/**
 * Hard timeout for a single upstream fetch (page HTML or oEmbed call).
 * Link previews are latency-sensitive (rendered inline under the composer),
 * so we'd rather return nothing than hang the request. Tunable via env.
 */
const FETCH_TIMEOUT_MS = Number(process.env.EMBED_METADATA_TIMEOUT_MS ?? 8000);

/**
 * Real browser User-Agent. Many sites serve different (og-less) markup to
 * non-browser agents or block default bot UAs outright. This is not a
 * guarantee (datacenter IPs still get 403'd by aggressive bot protection),
 * but it materially improves OG/oEmbed discovery yield.
 */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";

const ACCEPT_HTML =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

// ─── Types ──────────────────────────────────────────────────────────────
/**
 * Normalized link metadata, mirroring the SDK's `LinkEmbedData` shape so the
 * client's `LinkCard` can render it unchanged. All fields optional — a URL
 * may yield only a title, or nothing at all.
 */
export interface LinkEmbedMetadata {
  t?: string;
  d?: string;
  p?: { n?: string; u?: string };
  au?: { n?: string; u?: string };
  footer?: { t?: string };
  imgs?: { u: string; w?: number; h?: number; m?: string }[];
  vid?: { u: string; w?: number; h?: number; m?: string };
  thumb?: { u: string; w?: number; h?: number; m?: string };
}

// ─── Page fetch ─────────────────────────────────────────────────────────

/** A fetched page (HTML available only on 2xx). */
export interface PageResult {
  /** HTTP status; 0 signals a network/timeout failure (no response). */
  status: number;
  /** Response body as text. `null` when the status isn't 2xx or fetch failed. */
  html: string | null;
  /** Final URL after redirects (used to resolve relative og:image URLs). */
  finalUrl: string;
}

/**
 * Fetch a page with a browser UA, redirect following, and a hard timeout.
 * Unlike {@link fetchLinkMetadata}, this reports the HTTP status even on
 * failure so callers can classify stable 4xx (definitive) vs transient
 * (5xx/429/network) outcomes for retry scheduling.
 */
export async function fetchPage(
  url: string,
  signal?: AbortSignal,
): Promise<PageResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: ACCEPT_HTML,
        "Accept-Language": "en,en-US;q=0.9",
      },
      signal: controller.signal,
    });
    if (!res.ok) return { status: res.status, html: null, finalUrl: res.url || url };
    const html = await res.text();
    return { status: res.status, html, finalUrl: res.url || url };
  } catch {
    return { status: 0, html: null, finalUrl: url };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

// ─── HTML helpers ───────────────────────────────────────────────────────

/**
 * Decode the most common HTML entities found in attribute values and text
 * nodes. Keeps extracted metadata clean (e.g. `Tom &amp; Jerry` → `Tom & Jerry`).
 */
export function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

/**
 * Extract a meta tag's `content` by matching a `property` OR `name` attribute
 * with the given value (case-insensitive). Handles arbitrary attribute order.
 */
export function extractMeta(
  html: string,
  key: string,
  attr: "property" | "name",
): string | null {
  // Match <meta ... property/name="key" ... content="..."> regardless of
  // attribute order. We anchor on the key attr and capture content within the
  // same tag. Content may be double- or single-quoted.
  const re = new RegExp(
    `<meta[^>]*\\b${attr}\\s*=\\s*["']${escapeRegExp(key)}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i",
  );
  const m = html.match(re);
  return m?.[1] != null && m[1].trim() !== "" ? htmlDecode(m[1].trim()) : null;
}

/** The document `<title>` text. */
export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = m?.[1]?.trim();
  return t ? htmlDecode(t) : null;
}

/**
 * The oEmbed discovery endpoint for a page, or `null` if none is advertised.
 * Matches `<link rel="alternate" type="application/json+oembed" href="...">`
 * with attributes in any order.
 */
export function extractOEmbedEndpoint(html: string): string | null {
  const m = html.match(
    /<link[^>]*rel\s*=\s*["']alternate["'][^>]*type\s*=\s*["']application\/json\+oembed["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i,
  );
  return m?.[1] ? htmlDecode(m[1]) : null;
}

/** Escape a string for safe use in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the URL to call for an oEmbed discovery endpoint.
 *
 * Per the oEmbed spec the discovery `href` may be a template containing the
 * URL placeholder (e.g. `...?url={url}&format=json`). If no placeholder is
 * present, append the `url` query param.
 */
export function buildOEmbedUrl(endpoint: string, url: string): string {
  const enc = encodeURIComponent(url);
  const withUrl = endpoint
    .replace(/{(?:URL|url)}/g, enc)
    .replace(/%URL%/g, enc)
    .replace(/%url%/g, enc);
  if (withUrl !== endpoint) return withUrl;
  const sep = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${sep}url=${enc}`;
}

/** Extract the `src` of the first `<iframe>` (used for video/rich embeds). */
export function extractIframeSrc(html: string): string | null {
  const m = html.match(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i);
  return m?.[1] ? htmlDecode(m[1]) : null;
}

// ─── oEmbed ─────────────────────────────────────────────────────────────

interface OEmbedJson {
  type?: string;
  title?: string;
  description?: string;
  author_name?: string;
  author_url?: string;
  provider_name?: string;
  provider_url?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  width?: number;
  height?: number;
  html?: string;
}

/**
 * Fetch and parse an oEmbed endpoint for the given page URL. Returns `null`
 * on any failure (non-OK, timeout, non-JSON body).
 */
export async function fetchOEmbed(
  endpoint: string,
  url: string,
  signal?: AbortSignal,
): Promise<OEmbedJson | null> {
  const target = buildOEmbedUrl(endpoint, url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OEmbedJson;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Map an oEmbed response onto the normalized metadata shape. */
export function oEmbedToMetadata(o: OEmbedJson): LinkEmbedMetadata {
  const meta: LinkEmbedMetadata = {};
  if (o.title) meta.t = htmlDecode(o.title);
  if (o.description) meta.d = htmlDecode(o.description);
  if (o.provider_name) {
    meta.p = { n: htmlDecode(o.provider_name) };
    if (o.provider_url) meta.p.u = o.provider_url;
  }
  if (o.author_name) {
    meta.au = { n: htmlDecode(o.author_name) };
    if (o.author_url) meta.au.u = o.author_url;
  }
  if (o.thumbnail_url) {
    const img: NonNullable<LinkEmbedMetadata["imgs"]>[number] = {
      u: o.thumbnail_url,
    };
    if (o.thumbnail_width) img.w = o.thumbnail_width;
    if (o.thumbnail_height) img.h = o.thumbnail_height;
    meta.imgs = [img];
  }
  if (o.html) {
    const src = extractIframeSrc(o.html);
    if (src) meta.vid = { u: src };
  }
  return meta;
}

// ─── OpenGraph ──────────────────────────────────────────────────────────

/** Map OpenGraph/twitter meta tags onto the normalized metadata shape. */
export function ogToMetadata(html: string): LinkEmbedMetadata {
  const meta: LinkEmbedMetadata = {};

  const prop = (k: string) => extractMeta(html, k, "property");
  const name = (k: string) => extractMeta(html, k, "name");

  const title = prop("og:title") ?? name("twitter:title") ?? extractTitle(html);
  const description =
    prop("og:description") ??
    name("twitter:description") ??
    name("description");
  const image =
    prop("og:image") ?? name("twitter:image") ?? name("twitter:image:src");
  const siteName = prop("og:site_name");
  const video = prop("og:video") ?? prop("og:video:url");

  if (title) meta.t = title;
  if (description) meta.d = description;
  if (siteName) meta.p = { n: siteName };
  if (image) meta.imgs = [{ u: image }];
  if (video) meta.vid = { u: video };

  return meta;
}

/** Resolve a possibly-relative URL against the page's final URL. */
function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────

/**
 * Outcome of enriching a URL, classified for retry scheduling:
 *  - `ok`       — metadata was found.
 *  - `no-data`  — definitive: the URL has no metadata (page loaded but no
 *                 OG/oEmbed) or is stably unreachable (4xx). Not worth retrying.
 *  - `transient` — failed in a way that may succeed later (network/timeout,
 *                  5xx, 429). The caller should retry with backoff.
 */
export type ProbeResult =
  | { status: "ok"; metadata: LinkEmbedMetadata }
  | { status: "no-data" }
  | { status: "transient" };

/**
 * Enrich a URL with link metadata (oEmbed discovery + OpenGraph fallback),
 * returning a classified {@link ProbeResult} so the caller can schedule
 * retries for transient failures while settling definitive no-data URLs.
 */
export async function probeLinkMetadata(
  url: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  if (!/^https?:\/\//i.test(url)) return { status: "no-data" };

  const page = await fetchPage(url, signal);
  if (page.status === 0) return { status: "transient" }; // network/timeout

  if (page.status >= 400) {
    // Stable 4xx (bot-blocked, gone) settle; 429 & 5xx are transient.
    if (page.status === 429 || page.status >= 500) return { status: "transient" };
    return { status: "no-data" };
  }

  const html = page.html ?? "";
  const og = ogToMetadata(html);

  const endpoint = extractOEmbedEndpoint(html);
  if (endpoint) {
    const oembed = await fetchOEmbed(endpoint, page.finalUrl, signal);
    if (oembed) {
      // Prefer oEmbed data; fill gaps (e.g. description, og:image) from OG.
      return { status: "ok", metadata: mergeMetadata(oEmbedToMetadata(oembed), og) };
    }
  }

  return isEmpty(og) ? { status: "no-data" } : { status: "ok", metadata: og };
}

/**
 * Enrich a URL with link metadata (oEmbed discovery + OpenGraph fallback).
 * Returns `null` when the URL has no metadata or couldn't be fetched.
 * Thin wrapper over {@link probeLinkMetadata} for callers that only need the
 * metadata (e.g. the XRPC endpoint) and don't care about retry classification.
 */
export async function fetchLinkMetadata(
  url: string,
  signal?: AbortSignal,
): Promise<LinkEmbedMetadata | null> {
  const result = await probeLinkMetadata(url, signal);
  return result.status === "ok" ? result.metadata : null;
}


/** Merge `a` (preferred) over `b` (fallback), filling only absent fields. */
export function mergeMetadata(
  a: LinkEmbedMetadata,
  b: LinkEmbedMetadata,
): LinkEmbedMetadata {
  const out: LinkEmbedMetadata = { ...a };
  if (!out.t) out.t = b.t;
  if (!out.d) out.d = b.d;
  if (!out.p) out.p = b.p;
  if (!out.au) out.au = b.au;
  if (!out.footer) out.footer = b.footer;
  if (!out.imgs || out.imgs.length === 0) out.imgs = b.imgs;
  if (!out.vid) out.vid = b.vid;
  if (!out.thumb) out.thumb = b.thumb;
  return out;
}

function isEmpty(meta: LinkEmbedMetadata): boolean {
  return (
    !meta.t &&
    !meta.d &&
    !meta.p &&
    !meta.au &&
    !meta.imgs &&
    !meta.vid &&
    !meta.thumb
  );
}
