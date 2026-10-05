import { mount, unmount } from "svelte";
import SpaceRoomBadge from "./embeds/SpaceRoomBadge.svelte";
import { extractInternalLinkTargets, parseInternalLinkHref } from "@roomy-space/sdk";
import { setInternalLinkOrigins } from "@roomy/design/utils";
import { CONFIG } from "$lib/config";
import { internalOriginsFor } from "$lib/internal-link-origins";
import type { Block } from "@roomy-space/sdk";

export interface InternalLinkTarget {
  spaceId: string;
  roomId?: string;
}

/**
 * The origins an absolute link may be rooted at to name a space this client
 * can look up — this document's own origin and the web origin of the
 * appserver it talks to. See `internal-link-origins.ts`.
 */
export const internalLinkOrigins = internalOriginsFor(
  CONFIG.appserverDid,
  typeof location !== "undefined" ? location.origin : "",
);

// The design-system markdown renderer marks internal links as it renders, so
// it needs the same origins before the first message is rendered. Importing
// this module (which every render path does) is what configures it.
setInternalLinkOrigins(internalLinkOrigins);

/**
 * Extract the unique internal-link targets from a blocks+facets body.
 * Reads `#roomRef` facets directly (no DOM walk) via the SDK's
 * `extractInternalLinkTargets` — the blocks equivalent of the markdown
 * extractor in prefetch-link-summaries.ts.
 */
export function enrichInternalLinksFromBlocks(
  blocks: Block[],
): InternalLinkTarget[] {
  return extractInternalLinkTargets(blocks);
}

/**
 * Svelte action: after the markdown HTML is rendered inside `el`, find internal
 * links and replace them with SpaceRoomBadge components.
 *
 * Handles both relative links (/did:plc:xxx) and absolute URLs rooted at an
 * internal origin (https://roomy.space/did:plc:xxx).
 */
export function enrichInternalLinks(el: HTMLElement) {
  // The markdown renderer marks absolute links under the origins it was
  // configured with; mark anything the runtime considers internal too, so a
  // link written as an absolute URL to this deployment still becomes a badge.
  for (const origin of internalLinkOrigins) {
    for (const a of el.querySelectorAll<HTMLAnchorElement>(`a[href^="${origin}/"]`)) {
      a.setAttribute("data-roomy-internal-link", "true");
    }
  }

  const links = el.querySelectorAll<HTMLAnchorElement>('a[data-roomy-internal-link="true"]');
  if (links.length === 0) return;

  const mounted: Array<Record<string, any>> = [];

  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;

    const target = parseInternalLinkHref(href, internalLinkOrigins);
    if (!target) continue;

    // Only treat as explicit link text if it differs from the href (bare
    // URLs have text === href; [text](/did) links have custom text).
    const explicitText = link.textContent !== href ? (link.textContent ?? undefined) : undefined;

    // Mount the badge directly before the link, then remove the link.
    // Using `anchor` avoids a placeholder <span> that would add spacing.
    const badge = mount(SpaceRoomBadge, {
      target: link.parentElement!,
      anchor: link,
      props: {
        spaceId: target.spaceId,
        roomId: target.roomId,
        href,
        linkText: explicitText,
      },
    });
    link.remove();
    mounted.push(badge);
  }

  return {
    destroy() {
      for (const b of mounted) unmount(b);
    },
  };
}
