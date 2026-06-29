import type { Snippet } from "svelte";

let content = $state<Snippet | undefined>(undefined);

// Optional override for the left-hand "space info" slot of the navbar (the
// area that `NavbarSpaceInfo` fills with the space avatar + room icon/name).
// A page can replace it wholesale — e.g. the settings layout swaps in a
// cog icon + settings page name. When unset, the default `NavbarSpaceInfo`
// is rendered.
let spaceInfo = $state<Snippet | undefined>(undefined);

// Optional extra content rendered at the end of the space-info slot — e.g.
// the Discord bridge status badge on the discord-bridge settings page.
// Pages set/clear this alongside their own mount lifecycle.
let spaceInfoExtra = $state<Snippet | undefined>(undefined);

export const navbar = {
  get content() {
    return content;
  },
  get spaceInfo() {
    return spaceInfo;
  },
  get spaceInfoExtra() {
    return spaceInfoExtra;
  },
};

/**
 * Set the navbar content from a page. Pages should call this inside an
 * `$effect` and clear it on cleanup so stale content doesn't linger after
 * navigation:
 *
 *   $effect(() => {
 *     setNavbar(myNavbarSnippet);
 *     return () => setNavbar(undefined);
 *   });
 */
export function setNavbar(snippet: Snippet | undefined) {
  content = snippet;
}

/**
 * Replace the navbar's default space-info slot. Pass `undefined` to restore
 * the default `NavbarSpaceInfo`. As with `setNavbar`, clear it on cleanup.
 */
export function setSpaceInfo(snippet: Snippet | undefined) {
  spaceInfo = snippet;
}

/**
 * Set extra content appended to the space-info slot (e.g. a status badge).
 * Pass `undefined` to clear. Clear it on cleanup so it doesn't linger after
 * navigation.
 */
export function setSpaceInfoExtra(snippet: Snippet | undefined) {
  spaceInfoExtra = snippet;
}
