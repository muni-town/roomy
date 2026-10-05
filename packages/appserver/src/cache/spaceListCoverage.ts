/**
 * Which `space.getSpaces` entries a room-shaped change stales.
 *
 * `getSpaces` is a per-CALLER query: the response lists the spaces that caller
 * joined, and its params name no space at all (only an optional `includeLeft`
 * flag). So a room event has no param to name — the question it answers is
 * "does this caller's list contain the space whose room changed?", and only the
 * cached body can answer it.
 *
 * That is the same situation `activityFeedCoverage` describes for the feed, and
 * it needs the same treatment: subset matching reads `{ spaceId, roomId }` as a
 * subset of no entry's params, so it would match nothing and leave stale lists
 * for the callers who must see the change. The eviction listener therefore
 * matches these signals by coverage instead.
 *
 * A caller who cannot see the space has no row for it, and a room event in that
 * space cannot have moved any number the caller's list reports — so their entry
 * survives and no handler runs for them.
 */

/**
 * Whether a cached `getSpaces` body lists `spaceId`.
 *
 * The body is the validated query response (`{ spaces: SpaceRow[] }`); the row
 * id is the space DID. Anything else — a missing field, a shape from an older
 * build — reports `false`, leaving the entry to the TTL safety net rather than
 * evicting on an assumption.
 */
export function spacesCoverSpace(value: unknown, spaceId: string): boolean {
  if (value === null || typeof value !== "object" || !("spaces" in value)) return false;
  const rows = value.spaces;
  if (!Array.isArray(rows)) return false;
  return rows.some(
    (row) => row !== null && typeof row === "object" && "id" in row && row.id === spaceId,
  );
}
