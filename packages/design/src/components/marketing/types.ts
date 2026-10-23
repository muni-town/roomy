/**
 * One card's data in the welcome page's discover strip.
 *
 * The caller resolves a space's metadata, so it also says how far that lookup
 * got: `pending` while the request is in flight, `failed` if it errored, and
 * otherwise the resolved fields. `id` is always present, because it is what
 * the strip keys the card and addresses the space by.
 */
export type DiscoverableSpace = {
  id: string;
  /** Metadata still in flight — the card renders its skeleton. */
  pending?: boolean;
  /** The lookup failed — the card renders its error state. */
  failed?: boolean;
  name?: string;
  description?: string;
  /** An `atblob://` URI or a plain URL; `resolveBlobUrl` handles both. */
  avatar?: string | null;
};
