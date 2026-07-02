import { getAppserverOrigin } from "./appserver-origin";

/**
 * Resolve an atblob:// URI (or pass through a plain HTTP URL) to a
 * displayable URL.
 *
 * **Images** → `https://cdn.bsky.app/img/feed_fullsize/plain/<did>/<cid>`
 * (Bluesky's image CDN: cached, optimized).
 *
 * **Non-image** (video, files) → `<appserver>/blob/<did>/<cid>` — the
 * appserver proxies `com.atproto.sync.getBlob` from the blob owner's PDS.
 * `cdn.bsky.app/img/` only serves images, so video bytes must come from the
 * PDS directly.
 *
 * When `mimeType` is omitted (e.g. avatar callers that always pass images)
 * the image CDN path is used.
 *
 * Returns `undefined` if the URI cannot be parsed.
 */
export function resolveBlobUrl(
  uri: string | null | undefined,
  mimeType?: string,
): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("atblob://")) {
    // The materializer appends "?message=<ulid>" to embed entity ids, and
    // selectMessages returns that full string as the media url. Strip any
    // query/fragment before splitting did/cid.
    const rest = uri.slice("atblob://".length).split(/[?#]/)[0]!;
    const slash = rest.indexOf("/");
    if (slash === -1) return undefined;
    const did = rest.slice(0, slash);
    const cid = rest.slice(slash + 1);
    if (!did || !cid) return undefined;
    if (!mimeType || mimeType.startsWith("image/")) {
      return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`;
    }
    // Non-image (video, files): serve raw bytes via the appserver blob proxy.
    const origin = getAppserverOrigin();
    if (origin) return `${origin}/blob/${did}/${cid}`;
    // Origin not yet resolved — fall back to the image CDN (won't work for
    // video, but at least images still display during initial load).
    return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`;
  }
  return uri;
}
