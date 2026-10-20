import { mount, unmount } from "svelte";
import SpaceRoomBadge from "@roomy/design/components/content/thread/message/embeds/SpaceRoomBadge.svelte";
import { extractInternalLinkTargets, parseInternalLinkHref } from "@roomy-space/sdk";
import type { Block } from "@roomy-space/sdk";
import { internalLinkOrigins, setInternalLinkOrigins } from "@roomy/design/utils";
import type { InternalLinksConfig } from "./types.js";
import type { InternalLinkTarget } from "./types.js";

export type { InternalLinkTarget, InternalLinksConfig };

/**
 * What the client supplies, until it calls {@link configureInternalLinks}.
 *
 * Unconfigured, a link still renders — as a badge showing the target's own id
 * rather than its name — instead of taking its message row down with it. That
 * keeps the components renderable in isolation (which the stories are) and
 * turns a missing boot call into a visible degradation rather than a crash.
 */
let config: InternalLinksConfig = {
  origins: internalLinkOrigins,
  resolveSpace: async () => undefined,
};

/**
 * Declare the client's internal-link lookups: which origins count as this
 * deployment's own, how a space/room summary is fetched, and which space the
 * reader is in. See {@link InternalLinksConfig} for why these are injected
 * rather than imported.
 *
 * Call once at boot. The origins also configure the markdown renderer
 * (`setInternalLinkOrigins`), which marks internal links as it renders them —
 * so both halves of the seam read one list.
 */
export function configureInternalLinks(next: InternalLinksConfig): void {
  config = next;
  setInternalLinkOrigins(next.origins);
}

/**
 * Extract the unique internal-link targets from a blocks+facets body.
 * Reads `#roomRef` facets directly (no DOM walk) via the SDK's
 * `extractInternalLinkTargets` — the blocks equivalent of the markdown
 * extractor the app's prefetch pass runs over rendered HTML.
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
  for (const origin of config.origins) {
    for (const a of el.querySelectorAll<HTMLAnchorElement>(`a[href^="${origin}/"]`)) {
      a.setAttribute("data-roomy-internal-link", "true");
    }
  }

  const links = el.querySelectorAll<HTMLAnchorElement>('a[data-roomy-internal-link="true"]');
  if (links.length === 0) return;

  const mounted: Array<Record<string, any>> = [];
  const { origins, resolveSpace, resolveRoom, isCurrentSpace } = config;

  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;

    const target = parseInternalLinkHref(href, origins);
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
        resolveSpace,
        resolveRoom,
        // Read through the accessor on every render rather than captured:
        // navigating between spaces reuses the mounted badge, and the
        // suppression of the current space's own name must follow.
        isCurrentSpace: isCurrentSpace
          ? () => isCurrentSpace(target.spaceId)
          : undefined,
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
