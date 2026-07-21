/**
 * Per-room prefetch of internal-link badge summaries.
 *
 * The "enrich internal links" feature mounts a {@link SpaceRoomBadge} for every
 * internal link rendered in a message. Each badge issues its own
 * `getSpaceSummary` / `getRoomSummary` query on mount. In a virtualized message
 * list, scrolling recycles rows and re-runs the enrichment action, so without
 * prefetch every badge starts with a cold cache miss and fires an XRPC call —
 * one per link per render. Under normal scroll load this became the appserver
 * CPU/latency spike seen after the "enrich internal links" change.
 *
 * This module hoists that fan-out into a single per-room pass: it scans the
 * room's loaded message markdown for internal links, collects the unique
 * `(spaceId, roomId?)` targets, and calls `ensureQueryData` for each summary
 * query key. When the badges mount they hit the cache instead of issuing
 * cold fetches. Subsequent scroll-recycles are free.
 *
 * Only the lightweight summary queries are prefetched (not `getMetadata`),
 * matching what {@link SpaceRoomBadge} actually reads.
 */

import { cache } from "@roomy-space/sdk";
import { renderMarkdownSanitized } from "@roomy/design/utils";
import { queryClient } from "$lib/client";
import { px } from "$lib/auth.svelte";
import { parseInternalLinkHref } from "./enrich-internal-links";

const { queryKey } = cache;

const SPACE_SUMMARY = "space.roomy.space.getSpaceSummary";
const ROOM_SUMMARY = "space.roomy.room.getRoomSummary";

/**
 * Extract the unique internal-link targets from a set of markdown strings.
 *
 * Renders each markdown to the same sanitized HTML the message UI renders
 * (cached, so repeated calls are cheap), then parses out
 * `a[data-roomy-internal-link="true"]` hrefs and runs
 * {@link parseInternalLinkHref} on each. This guarantees parity with the
 * {@link enrichInternalLinks} action: the prefetcher sees exactly the links
 * that will be enriched.
 *
 * `appOrigin` is `location.origin` at the call site; passed in so the function
 * is pure and testable.
 */
export function extractInternalLinkTargets(
  markdowns: Iterable<string>,
  appOrigin: string,
): { spaceId: string; roomId?: string }[] {
  const seen = new Set<string>();
  const targets: { spaceId: string; roomId?: string }[] = [];

  for (const markdown of markdowns) {
    if (!markdown) continue;
    const html = renderMarkdownSanitized(markdown);
    if (!html.includes("data-roomy-internal-link")) continue;

    const doc = new DOMParser().parseFromString(html, "text/html");
    const anchors = doc.querySelectorAll<HTMLAnchorElement>(
      'a[data-roomy-internal-link="true"]',
    );
    for (const a of anchors) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const target = parseInternalLinkHref(href, appOrigin);
      if (!target) continue;
      // Dedupe by `${spaceId}/${roomId ?? ""}`. Two links to the same room
      // share one cache entry — that's the whole point.
      const dedupeKey = `${target.spaceId}/${target.roomId ?? ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      targets.push(target);
    }
  }

  return targets;
}

/**
 * Prefetch the `getSpaceSummary` / `getRoomSummary` queries for every
 * internal link target referenced by the given markdown strings.
 *
 * Uses `queryClient.ensureQueryData`, which returns immediately on a cache
 * hit and only fetches on a miss. `staleTime: Infinity` (the app default,
 * see `client.ts`) means a prefetched entry stays fresh and badges never
 * re-fetch it. The promise is intentionally not awaited by callers — the
 * prefetch is best-effort and should not block rendering; badges will render
 * with their own loading state (the spaceId/roomId fallback text) until the
 * data lands.
 *
 * Call from a Svelte `$effect` that tracks the loaded message list so the
 * cache is warmed as new messages arrive (e.g. infinite-scroll pages).
 */
export function prefetchInternalLinkSummaries(
  markdowns: Iterable<string>,
  appOrigin: string = typeof location !== "undefined" ? location.origin : "",
): void {
  if (!appOrigin) return; // SSR / non-browser — nothing to prefetch.
  const targets = extractInternalLinkTargets(markdowns, appOrigin);
  if (targets.length === 0) return;

  const pxClient = px();
  for (const { spaceId, roomId } of targets) {
    // Space summary is always needed (the badge shows the space avatar+name
    // unless this is the current space, which the badge itself decides).
    void queryClient.ensureQueryData({
      queryKey: queryKey(SPACE_SUMMARY, { spaceId }),
      queryFn: () => pxClient.query(SPACE_SUMMARY, { spaceId }),
    });
    if (roomId) {
      void queryClient.ensureQueryData({
        queryKey: queryKey(ROOM_SUMMARY, { roomId }),
        queryFn: () => pxClient.query(ROOM_SUMMARY, { roomId }),
      });
    }
  }
}