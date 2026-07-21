import { mount, unmount } from "svelte";
import SpaceRoomBadge from "./embeds/SpaceRoomBadge.svelte";

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

    // Parse the path: relative links start with /, absolute URLs need URL parsing
    let path: string;
    if (href.startsWith("/")) {
      path = href;
    } else {
      try {
        path = new URL(href).pathname;
      } catch {
        continue;
      }
    }

    // Extract spaceId and optional roomId from the path
    const parts = path.slice(1).split("/");
    const linkSpaceId = parts[0];
    if (!linkSpaceId) continue;
    // Skip non-space routes like /user/<did>
    if (linkSpaceId === "user") continue;
    const linkRoomId = parts[1];

    // Only treat as explicit link text if it differs from the href (bare
    // URLs have text === href; [text](/did) links have custom text).
    const explicitText = link.textContent !== href ? (link.textContent ?? undefined) : undefined;

    // Mount the badge directly before the link, then remove the link.
    // Using `anchor` avoids a placeholder <span> that would add spacing.
    const badge = mount(SpaceRoomBadge, {
      target: link.parentElement!,
      anchor: link,
      props: {
        spaceId: linkSpaceId,
        roomId: linkRoomId,
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
