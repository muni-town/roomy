/**
 * Link-to-tile resolution: which URLs a Web Tile renders, and the payload that
 * tile is handed.
 *
 * A message that links a Bluesky post already gets its OpenGraph card from
 * {@link probeLinkMetadata} — and for `bsky.app`, that is usually nothing at
 * all, because the origin refuses scrapers. The record behind the link is
 * available without scraping, so this module reads it from the public AppView
 * and turns it into the bounded payload a tile renders.
 *
 * Two halves, split because a read must not do network:
 *
 *   - {@link recogniseTileUrl} is pure: it says whether a URL addresses a
 *     content type a tile mapping claims, and which record. Read paths call it
 *     to decide whether a row needs resolution.
 *   - {@link resolveTileForUrl} does the outbound work: resolve a handle, fetch
 *     the record, project it. The embed sweeper calls it, so one URL is
 *     resolved once for every message that links it.
 *
 * The mapping is by convention (§5.4 of the Web Tiles plan): Roomy publishes a
 * default tile per content type and every space uses it. Nothing else in the
 * pipeline depends on where the default came from, so replacing the table with
 * a catalogue later is a change here alone.
 */

import { MAX_TILE_DATA_BYTES } from "@roomy-space/sdk";
import { fetchWithTimeout } from "../fetchTimeout.ts";
import type { EmbedTile } from "./types.ts";

/**
 * Bump when the projection's shape or the mapping changes: rows stamped with
 * an older version are stale and are resolved again on their next read.
 */
export const TILE_RESOLVER_VERSION = 2;

/** Collection of a Web Tile manifest record. */
export const TILE_COLLECTION = "ing.dasl.masl";

/**
 * The published Bluesky-post tile.
 *
 * Pure renderer: it fetches nothing and draws `data.post` from the payload
 * handed to it over the tiles data-passing protocol. Published from
 * `packages/appserver/tiles/bluesky-post/` by
 * `packages/appserver/scripts/publish-tile.ts`.
 */
export const BLUESKY_POST_TILE_URI =
  "at://did:plc:uzi5qarfn75i6txjbqidz2wc/ing.dasl.masl/3mytebpmejn2w";

/** Content type → the tile that renders it. */
export const TILE_MAPPING: Record<string, string> = {
  "app.bsky.feed.post": BLUESKY_POST_TILE_URI,
};

/**
 * The AppView tile data is read from. Unauthenticated: the payload must never
 * carry a viewer, so no session is used and the response is the same for
 * every reader. Overridable so a test can point it at a stub.
 */
export function appviewEndpoint(): string {
  const raw = process.env.BLUESKY_APPVIEW_ENDPOINT;
  return raw && raw.length > 0 ? raw.replace(/\/+$/, "") : "https://public.api.bsky.app";
}

/** Deadline for one AppView call. A tile is an enhancement, never a blocker. */
function tileFetchTimeoutMs(): number {
  const raw = Number(process.env.EMBED_TILE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

// ─── Recognition ────────────────────────────────────────────────────────

/**
 * A URL that addresses a record a tile mapping claims.
 *
 * `did` and `handle` are alternatives: `bsky.app` links name whichever the
 * author copied, while an `at://` URI names its authority directly.
 */
export interface RecognisedTileUrl {
  collection: string;
  rkey: string;
  did?: string;
  handle?: string;
}

/** A record key: `[A-Za-z0-9._:~-]`, 1–512 of them. */
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;
/** A DID's method + method-specific id, without the `did:` prefix. */
const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
/** A handle: at least two dot-separated labels. */
const HANDLE = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/** `bsky.app` hosts a post as `/profile/<handle|did>/post/<rkey>`. */
const BSKY_APP_HOSTS: Record<string, true> = {
  "bsky.app": true,
  "www.bsky.app": true,
};

/**
 * Whether a URL addresses a record a tile renders, and which one.
 *
 * Pure and network-free by design: the read path calls this on every link it
 * serves, so it must not cost a round-trip. A `bsky.app` link whose author is
 * a handle is recognised without resolving that handle.
 *
 * Returns null for everything this cut does not map — a profile link, an
 * `at://` URI of another collection, a URL of another host — because a
 * recognised-but-unmapped URL would only enqueue work that resolves to no
 * tile.
 */
export function recogniseTileUrl(url: string): RecognisedTileUrl | null {
  // A bare `at://` URI in a link facet keeps its own scheme. It is parsed as
  // text, not with `URL`: a DID authority contains colons, which `URL` reads as
  // a port and rejects outright, so `new URL("at://did:plc:…")` throws.
  if (url.startsWith("at://")) {
    const [authority, collection, rawKey] = url.slice("at://".length).split("/");
    const rkey = rawKey?.split(/[?#]/)[0];
    if (!authority || !collection || !rkey || !RKEY.test(rkey)) return null;
    if (!(collection in TILE_MAPPING)) return null;
    if (DID.test(authority)) return { collection, rkey, did: authority };
    if (HANDLE.test(authority)) {
      return { collection, rkey, handle: authority.toLowerCase() };
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (BSKY_APP_HOSTS[parsed.hostname.toLowerCase()] !== true) return null;

  const [profile, author, post, rkey] = parsed.pathname
    .replace(/^\/+/, "")
    .split("/");
  if (profile !== "profile" || post !== "post" || !author || !rkey) return null;
  if (!RKEY.test(rkey)) return null;
  const collection = "app.bsky.feed.post";
  if (!(collection in TILE_MAPPING)) return null;
  if (DID.test(author)) return { collection, rkey, did: author };
  if (HANDLE.test(author)) return { collection, rkey, handle: author.toLowerCase() };
  return null;
}

// ─── Handle resolution ──────────────────────────────────────────────────

/**
 * Handles seen since boot, mapped to their DID.
 *
 * A `bsky.app` link names its author by handle, and a handle is resolved by an
 * outbound call the AppView charges for. Handles change rarely and never for a
 * post that already exists, so the process answers from here after the first
 * lookup. Bounded so a firehose of distinct handles cannot grow it without
 * limit; the oldest entry goes first.
 */
const HANDLE_CACHE_LIMIT = 2048;
const handleCache = new Map<string, string>();

/** Record a handle → DID answer, evicting the oldest entry past the limit. */
function rememberHandle(handle: string, did: string): void {
  if (handleCache.size >= HANDLE_CACHE_LIMIT) {
    const oldest = handleCache.keys().next();
    if (!oldest.done) handleCache.delete(oldest.value);
  }
  handleCache.set(handle, did);
}

/** Drop the memoised handles. Tests only. */
export function _resetTileCachesForTest(): void {
  handleCache.clear();
}

/**
 * The DID behind `handle`, or null when it cannot be resolved now.
 *
 * `null` and a thrown error are the same answer to the caller: no tile this
 * time, try again later.
 */
export async function resolveHandle(
  handle: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cached = handleCache.get(handle);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(
      `${appviewEndpoint()}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      { signal },
      tileFetchTimeoutMs(),
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { did?: unknown };
    if (typeof body.did !== "string" || !DID.test(body.did)) return null;
    rememberHandle(handle, body.did);
    return body.did;
  } catch {
    return null;
  }
}

// ─── The record ─────────────────────────────────────────────────────────

/** An image in a post's embed, reduced to what a tile can draw. */
export interface PostTileImage {
  thumb: string;
  alt?: string;
}

/** An external link in a post's embed, reduced to what a tile can draw. */
export interface PostTileExternal {
  kind: "external";
  uri: string;
  title?: string;
  description?: string;
  thumb?: string;
}

/**
 * The media a quoted post contributes: its own first embed, one level deep.
 *
 * A quote never nests another quote and never carries a video, and an image
 * contribution is a single image, so a quoted post cannot grow the payload by
 * quoting again.
 */
export type QuoteTileMedia =
  | { kind: "image"; images: PostTileImage[] }
  | PostTileExternal;

/**
 * The bounded projection of a post handed to the tile.
 *
 * The same entry shape a `space.roomy.attachment.tile.v0` carries as `data`,
 * so one tile renders a linked and an attached post alike.
 */
export interface BlueskyPostTileData {
  post: {
    uri: string;
    cid?: string;
    author: {
      did: string;
      handle: string;
      displayName?: string;
      avatar?: string;
    };
    text: string;
    createdAt: string;
    counts: {
      like: number;
      repost: number;
      reply: number;
      quote: number;
    };
    /** The first image, external link or quoted post, as one of these. */
    embed?:
      | { kind: "image"; images: PostTileImage[] }
      | PostTileExternal
      | {
          kind: "quote";
          uri: string;
          author: { handle: string; displayName?: string; avatar?: string };
          text?: string;
          /** The quoted post's own first embed, one level deep. */
          media?: QuoteTileMedia;
        }
      | { kind: "video"; thumb?: string; alt?: string };
  };
}

/** How much of a post's text the tile is given before it is cut short. */
const MAX_POST_TEXT = 1024;

/** A string field, or undefined when absent or not a string. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A count field, defaulting to 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A record from an unknown JSON value, or an empty one. */
function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The author fields a tile draws, from a post view's `author`. */
function projectAuthor(author: unknown): BlueskyPostTileData["post"]["author"] {
  const a = obj(author);
  return {
    did: str(a.did) ?? "",
    handle: str(a.handle) ?? "",
    ...(str(a.displayName) ? { displayName: str(a.displayName)! } : {}),
    ...(str(a.avatar) ? { avatar: str(a.avatar)! } : {}),
  };
}

/** A hydrated external link, or undefined when it has no usable URI. */
function projectExternal(external: unknown): PostTileExternal | undefined {
  const e = obj(external);
  const uri = str(e.uri);
  if (!uri) return undefined;
  // A hydrated view carries the thumbnail as a URL; an unhydrated blob ref
  // only as a `$link`, which is not fetchable from the client.
  const thumb = obj(e.thumb);
  const thumbUrl = str(thumb.thumb) ?? str(thumb.$link);
  return {
    kind: "external",
    uri,
    ...(str(e.title) ? { title: str(e.title)! } : {}),
    ...(str(e.description) ? { description: str(e.description)! } : {}),
    ...(thumbUrl ? { thumb: thumbUrl } : {}),
  };
}

/**
 * The media of a quoted post: its own first embed, one level deep.
 *
 * Only an image set (reduced to its first image) and an external link are
 * carried. A quoted quote and a quoted video are not: each would either grow
 * without a bound or need a player the tile does not have.
 */
function projectQuoteMedia(embed: unknown): QuoteTileMedia | undefined {
  const e = obj(embed);
  switch (str(e.$type)) {
    case "app.bsky.embed.images#view": {
      const first = Array.isArray(e.images) ? e.images[0] : undefined;
      const img = obj(first);
      const thumb = str(img.thumb);
      if (!thumb) return undefined;
      return {
        kind: "image",
        images: [{ thumb, ...(str(img.alt) ? { alt: str(img.alt)! } : {}) }],
      };
    }
    case "app.bsky.embed.external#view":
      return projectExternal(e.external);
    default:
      return undefined;
  }
}

/**
 * The first image, external link or quoted post of a post view's `embed`, if
 * it carries one. A quoted post's own media travels one level further
 * ({@link projectQuoteMedia}) and no deeper; a video's playlist is left out.
 */
function projectEmbed(
  embed: unknown,
): BlueskyPostTileData["post"]["embed"] | undefined {
  const e = obj(embed);
  switch (str(e.$type)) {
    case "app.bsky.embed.images#view": {
      const images = Array.isArray(e.images) ? e.images.slice(0, 4) : [];
      const projected: PostTileImage[] = [];
      for (const raw of images) {
        const img = obj(raw);
        const thumb = str(img.thumb);
        if (!thumb) continue;
        projected.push({ thumb, ...(str(img.alt) ? { alt: str(img.alt)! } : {}) });
      }
      return projected.length > 0 ? { kind: "image", images: projected } : undefined;
    }
    case "app.bsky.embed.external#view":
      return projectExternal(e.external);
    case "app.bsky.embed.record#view": {
      const record = obj(e.record);
      const uri = str(record.uri);
      if (!uri) return undefined;
      const author = obj(record.author);
      const value = obj(record.value);
      // A hydrated record view carries the quoted post's embeds as a list; the
      // singular form is what an unhydrated one would use.
      const nested = Array.isArray(record.embeds)
        ? record.embeds[0]
        : record.embed;
      const media = projectQuoteMedia(nested);
      return {
        kind: "quote",
        uri,
        author: {
          handle: str(author.handle) ?? "",
          ...(str(author.displayName) ? { displayName: str(author.displayName)! } : {}),
          ...(str(author.avatar) ? { avatar: str(author.avatar)! } : {}),
        },
        ...(str(value.text) ? { text: str(value.text)!.slice(0, MAX_POST_TEXT) } : {}),
        ...(media ? { media } : {}),
      };
    }
    case "app.bsky.embed.video#view": {
      const thumbnail = str(e.thumbnail);
      return {
        kind: "video",
        ...(thumbnail ? { thumb: thumbnail } : {}),
        ...(str(e.alt) ? { alt: str(e.alt)! } : {}),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Project one `app.bsky.feed.getPosts` entry into the tile payload.
 *
 * The payload is a projection rather than the post view: the view carries
 * viewer state, labels, blob refs and a record body, none of which a renderer
 * needs and all of which would be stored for every message that links it.
 * Nothing requester-specific is ever read, so one stored row is the same for
 * every reader.
 *
 * Bounded to {@link MAX_TILE_DATA_BYTES} — the same ceiling the write path
 * enforces on an attached tile's payload. The text is shortened first, then a
 * quoted post's own media is dropped, then the embed itself; a post that still
 * does not fit yields no payload at all, which renders the tile's card without
 * a body rather than storing an unbounded one.
 */
export function projectPost(
  postView: unknown,
): BlueskyPostTileData | undefined {
  const view = obj(postView);
  const uri = str(view.uri);
  if (!uri) return undefined;

  const record = obj(view.record);
  const fullText = str(record.text) ?? "";
  const embed = projectEmbed(view.embed);

  const build = (
    text: string,
    withEmbed: BlueskyPostTileData["post"]["embed"],
  ): BlueskyPostTileData => ({
    post: {
      uri,
      ...(str(view.cid) ? { cid: str(view.cid)! } : {}),
      author: projectAuthor(view.author),
      text,
      createdAt: str(record.createdAt) ?? str(view.indexedAt) ?? "",
      counts: {
        like: count(view.likeCount),
        repost: count(view.repostCount),
        reply: count(view.replyCount),
        quote: count(view.quoteCount),
      },
      ...(withEmbed ? { embed: withEmbed } : {}),
    },
  });

  const fits = (candidate: BlueskyPostTileData): boolean =>
    Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_TILE_DATA_BYTES;

  // The embed stages, ordered by how much the reader loses: the whole embed,
  // then a quote with its media removed, then no embed at all. Within a stage
  // the text is shortened furthest first, so the payload keeps as much of the
  // post as the bound allows before anything is dropped.
  const stages: Array<BlueskyPostTileData["post"]["embed"]> = [];
  if (embed) {
    stages.push(embed);
    if (embed.kind === "quote" && embed.media) {
      stages.push({
        kind: "quote",
        uri: embed.uri,
        author: embed.author,
        ...(embed.text !== undefined ? { text: embed.text } : {}),
      });
    }
  }
  stages.push(undefined);

  for (const stage of stages) {
    let text = fullText.slice(0, MAX_POST_TEXT);
    for (;;) {
      const candidate = build(text, stage);
      if (fits(candidate)) return candidate;
      if (text.length === 0) break;
      text = text.slice(0, Math.floor(text.length / 2));
    }
  }
  return undefined;
}

// ─── Resolution ─────────────────────────────────────────────────────────

/**
 * What one tile resolution produced.
 *
 * `definitive` means the record is gone or the AppView refuses this query
 * forever (a deleted post, a malformed record): retrying cannot change it, so
 * the row is stamped with the resolver version and left alone. `transient`
 * means try again later — the caller keeps the row pending and the sweeper's
 * backoff schedule owns the retry.
 */
export type TileResolution =
  | { status: "ok"; tile: EmbedTile }
  | { status: "definitive" }
  | { status: "transient" };

/**
 * The bare AT-URI of the record a recognised URL addresses.
 *
 * A `bsky.app` link names its author by handle, so this is where the handle
 * becomes a DID. Returns null when the handle cannot be resolved now.
 */
export async function tileAtUri(
  recognised: RecognisedTileUrl,
  signal?: AbortSignal,
): Promise<string | null> {
  const did =
    recognised.did ??
    (recognised.handle ? await resolveHandle(recognised.handle, signal) : null);
  if (!did) return null;
  return `at://${did}/${recognised.collection}/${recognised.rkey}`;
}

/**
 * Resolve a URL to the tile that renders it and the payload it is given.
 *
 * Returns null when the URL is not one a mapping claims — the caller then has
 * nothing to do. One unauthenticated AppView call per resolution, and none at
 * all for a record the AppView has already refused.
 */
export async function resolveTileForUrl(
  url: string,
  signal?: AbortSignal,
): Promise<TileResolution | null> {
  const recognised = recogniseTileUrl(url);
  if (!recognised) return null;

  const tileUri = TILE_MAPPING[recognised.collection];
  if (!tileUri) return null;

  const atUri = await tileAtUri(recognised, signal);
  // A handle that does not resolve is transient: a directory service can be
  // down, and a handle can be re-verified.
  if (!atUri) return { status: "transient" };

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${appviewEndpoint()}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`,
      { signal },
      tileFetchTimeoutMs(),
    );
  } catch {
    return { status: "transient" };
  }

  if (res.status === 429 || res.status >= 500) return { status: "transient" };
  if (!res.ok) return { status: "definitive" };

  let body: { posts?: unknown };
  try {
    body = (await res.json()) as { posts?: unknown };
  } catch {
    return { status: "transient" };
  }

  // An empty list is the AppView saying the record is not there. Retrying a
  // deleted post every sweep would pin the backlog on it (the same reasoning
  // as a stable 4xx on the OpenGraph path).
  const posts = Array.isArray(body.posts) ? body.posts : [];
  const match =
    posts.find((p) => str(obj(p).uri) === atUri) ??
    (posts.length === 1 ? posts[0] : undefined);
  if (!match) return { status: "definitive" };

  const data = projectPost(match);
  return {
    status: "ok",
    tile: { url: tileUri, ...(data ? { data } : {}) },
  };
}
