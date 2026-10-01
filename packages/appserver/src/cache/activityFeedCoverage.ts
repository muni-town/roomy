/**
 * Which `space.getActivityFeed` params a single space's write makes stale.
 *
 * The feed is a per-CALLER query spanning every space the caller joined
 * (`queries/activityFeed.ts` fans out over `selectJoinedSpaceDids`), and its
 * params name a space only as a filter. So a signal naming one space does not
 * describe a param set — it describes which cached pages hold that space:
 *
 * | feed params        | the cached page holds | a write to X stales |
 * |--------------------|-----------------------|---------------------|
 * | `{ spaceId: "X" }` | X's rooms             | that page           |
 * | `{ spaceId: "Y" }` | Y's rooms             | nothing             |
 * | `{}` / `{ limit }` | X's and Y's           | every such page     |
 *
 * This is the definition of that column, and the reason the ordinary
 * param-subset rule cannot be used for this one NSID: `{ spaceId: "X" }` is a
 * subset of no entry's params, so subset matching would read the signal as
 * "every page" and evict the whole feed on any write anywhere.
 */

/** The space a page's params restrict it to, or `null` for "every space". */
export function activityFeedCoverage(
  params: Readonly<Record<string, string>>,
): string | null {
  const spaceId = params["spaceId"];
  return spaceId === undefined || spaceId === "" ? null : spaceId;
}
