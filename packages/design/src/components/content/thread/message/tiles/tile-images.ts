/**
 * The bytes behind an image a tile draws.
 *
 * A tile has no network of its own: the loader's service worker answers every
 * request its frame makes — off-origin ones included — by asking this page to
 * resolve the path (see `withTileImages` in `./mothership.ts`). A picture the
 * tile was told about by URL therefore paints only if this page hands the
 * worker its bytes.
 *
 * The bytes come from the author's repository rather than the image host. A
 * Bluesky CDN URL names a blob the author's PDS already serves —
 * `cdn.bsky.app/img/<variant>/plain/<did>/<cid>` — and a PDS answers
 * `com.atproto.sync.getBlob` with an `access-control-allow-origin` that lets
 * this page read it. `cdn.bsky.app` itself sends no CORS header, so its bytes
 * can be drawn by an `<img>` but never read and passed on. The blob is the
 * original the CDN derived its thumbnail from, so it is larger than the URL the
 * tile was given; the cache bounds what that costs, and an image past the size
 * cap is refused rather than handed over.
 */

/** An image ready to hand back through a tile's path resolution. */
export interface TileImageBytes {
  contentType: string;
  bytes: Uint8Array;
}

/**
 * The path prefix a tile asks for an image at: the CDN URL, percent-encoded,
 * after `/image/`. A path rather than a query string because the loader's
 * worker resolves pathnames only.
 */
export const TILE_IMAGE_PATH = "/image/";

/**
 * A Bluesky CDN image URL: the variant and `plain` form that carries the
 * repository DID and blob CID, with an optional `@format` suffix. Nothing
 * looser is fetched — an arbitrary URL on the tile's behalf would make this
 * page a proxy for any host the post names.
 */
const CDN_IMAGE =
  /^https:\/\/cdn\.bsky\.app\/img\/[a-z_]+\/plain\/(did:plc:[a-z2-7]+)\/([a-z2-7]+)(?:@[a-z]+)?$/;

/** The largest single image handed to a tile; past this the request is refused. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Entries kept for reuse, and the most they may hold; both bound the oldest out. */
const MAX_CACHED_ENTRIES = 32;
const MAX_CACHED_BYTES = 16 * 1024 * 1024;

/** Fetches in flight at once, and how long one may take. */
const MAX_CONCURRENT_FETCHES = 4;
const FETCH_TIMEOUT_MS = 10_000;

/** DID → the PDS that serves it, and `did/cid` → the bytes it names. */
const pdsCache = new Map<string, string>();
const imageCache = new Map<string, TileImageBytes>();
const inFlight = new Map<string, Promise<TileImageBytes | null>>();
let cachedBytes = 0;

/** Fetches running now, and the callers waiting for one to finish. */
let activeFetches = 0;
const waiting: Array<() => void> = [];

/** The DID and blob CID a Bluesky CDN image URL names, or null for any other URL. */
export function parseCdnImageUrl(url: string): { did: string; cid: string } | null {
  const match = CDN_IMAGE.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { did: match[1], cid: match[2] };
}

/** Run `fetchIt` once a slot is free, so a grid of images cannot flood a PDS. */
async function withinFetchBudget<T>(fetchIt: () => Promise<T>): Promise<T> {
  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    // `Promise.withResolvers` is outside this package's lib target, so the
    // resolver is captured from the executor.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  activeFetches++;
  try {
    return await fetchIt();
  } finally {
    activeFetches--;
    waiting.shift()?.();
  }
}

/** The service endpoint of a DID's PDS, or null when it cannot be read now. */
async function pdsFor(did: string): Promise<string | null> {
  const known = pdsCache.get(did);
  if (known) return known;
  const endpoint = await withinFetchBudget(async () => {
    try {
      const res = await fetch(`https://plc.directory/${did}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const doc = (await res.json()) as {
        service?: Array<{ id?: unknown; serviceEndpoint?: unknown }>;
      };
      const endpoint = doc.service?.find((entry) => entry.id === "#atproto_pds")?.serviceEndpoint;
      return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : null;
    } catch {
      return null;
    }
  });
  if (!endpoint) return null;
  if (pdsCache.size >= MAX_CACHED_ENTRIES) {
    const oldest = pdsCache.keys().next();
    if (!oldest.done) pdsCache.delete(oldest.value);
  }
  pdsCache.set(did, endpoint);
  return endpoint;
}

/** Remember bytes, dropping the least recently used entries to stay within both caps. */
function remember(key: string, image: TileImageBytes): void {
  const existing = imageCache.get(key);
  if (existing) {
    cachedBytes -= existing.bytes.byteLength;
    imageCache.delete(key);
  }
  imageCache.set(key, image);
  cachedBytes += image.bytes.byteLength;
  for (const [cachedKey, cached] of imageCache) {
    if (cachedKey === key) continue;
    if (imageCache.size <= MAX_CACHED_ENTRIES && cachedBytes <= MAX_CACHED_BYTES) break;
    imageCache.delete(cachedKey);
    cachedBytes -= cached.bytes.byteLength;
  }
}

/** Mark an entry as the most recently used one. */
function touch(key: string, image: TileImageBytes): TileImageBytes {
  if (imageCache.get(key) === image) {
    imageCache.delete(key);
    imageCache.set(key, image);
  }
  return image;
}

/** Read one blob from a repository, or null when it is not an image this page hands over. */
async function readBlob(pds: string, did: string, cid: string): Promise<TileImageBytes | null> {
  return withinFetchBudget(async () => {
    try {
      const res = await fetch(
        `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) return null;
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
      return { contentType, bytes };
    } catch {
      return null;
    }
  });
}

/**
 * The bytes an image URL names, or null when they cannot be read: not a
 * Bluesky CDN image, a repository that cannot be resolved, a blob the PDS
 * refuses, something that is not an image, or an image past the size cap.
 */
export async function tileImageBytes(url: string): Promise<TileImageBytes | null> {
  const blobRef = parseCdnImageUrl(url);
  if (!blobRef) return null;
  const key = `${blobRef.did}/${blobRef.cid}`;

  const cached = imageCache.get(key);
  if (cached) return touch(key, cached);

  // One fetch per blob however many frames ask for it at once.
  const running = inFlight.get(key);
  if (running) return running;

  const request = (async () => {
    const pds = await pdsFor(blobRef.did);
    if (!pds) return null;
    const image = await readBlob(pds, blobRef.did, blobRef.cid);
    if (image) remember(key, image);
    return image;
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}

/** Drop everything remembered. Tests only. */
export function _resetTileImageCacheForTest(): void {
  pdsCache.clear();
  imageCache.clear();
  inFlight.clear();
  cachedBytes = 0;
  activeFetches = 0;
  waiting.length = 0;
}
