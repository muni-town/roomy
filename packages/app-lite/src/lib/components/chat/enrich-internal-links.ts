import { mount, unmount } from "svelte";
import SpaceRoomBadge from "./embeds/SpaceRoomBadge.svelte";

// Known Roomy domains — bare links to these are treated as internal space/room
// references. Must stay in sync with packages/design/src/utils/markdown.ts
// (ROOMY_DOMAINS) so the extractor sees the same links the renderer marks.
const ROOMY_DOMAINS = new Set(["roomy.space", "a.roomy.space", "roomy.chat"]);

export interface InternalLinkTarget {
  spaceId: string;
  roomId?: string;
}

/**
 * Parse a single href into an internal link target, or `null` if it isn't a
 * Roomy space/room reference.
 *
 * Mirrors the path-parsing logic in {@link enrichInternalLinks} and the
 * internal-link marking in `packages/design/src/utils/markdown.ts`:
 *   - relative links starting with `/`
 *   - absolute URLs whose host is a known Roomy domain (roomy.space, …)
 *   - absolute URLs whose host is the app's own origin (the renderer can't
 *     know the origin at build time, so the action marks these; the extractor
 *     accepts them too so prefetch covers every link the action would enrich)
 *
 * `/user/<did>` and other non-space routes are skipped (matches the action).
 * `appOrigin` is optional so the function stays pure and testable; the action
 * and prefetcher pass `location.origin`.
 */
export function parseInternalLinkHref(
  href: string,
  appOrigin?: string,
): InternalLinkTarget | null {
  let path: string;
  if (href.startsWith("/")) {
    path = href;
  } else {
    try {
      const url = new URL(href);
      const isRoomyDomain = ROOMY_DOMAINS.has(url.hostname);
      const isAppOrigin = appOrigin !== undefined && url.origin === appOrigin;
      if (!isRoomyDomain && !isAppOrigin) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  }

  const parts = path.slice(1).split("/");
  const spaceId = parts[0];
  if (!spaceId || spaceId === "user") return null;
  const roomId = parts[1];
  return roomId ? { spaceId, roomId } : { spaceId };
}

/**
 * Svelte action: after the markdown HTML is rendered inside `el`, find internal
 * links and replace them with SpaceRoomBadge components.
 *
 * Handles both relative links (/did:plc:xxx) and absolute URLs
 * (https://roomy.space/did:plc:xxx).
 */
export function enrichInternalLinks(el: HTMLElement) {
  // Also mark links to the app's own origin as internal (the markdown
  // renderer can't know the app's origin at build time).
  const appOrigin = location.origin;
  for (const a of el.querySelectorAll<HTMLAnchorElement>(`a[href^="${appOrigin}/"]`)) {
    a.setAttribute("data-roomy-internal-link", "true");
  }

  const links = el.querySelectorAll<HTMLAnchorElement>('a[data-roomy-internal-link="true"]');
  if (links.length === 0) return;

  const mounted: Array<Record<string, any>> = [];

  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;

    const target = parseInternalLinkHref(href, appOrigin);
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
