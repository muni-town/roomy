/**
 * Resolve an atblob:// URI (or plain HTTP URL) to a displayable CDN image URL.
 *
 * `atblob://<did>/<cid>` → `https://cdn.bsky.app/img/feed_fullsize/plain/<did>/<cid>`
 *
 * Returns `undefined` if the URI cannot be parsed.
 */
export function resolveBlobUrl(
  uri: string | null | undefined,
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
    return `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}`;
  }
  return uri;
}
