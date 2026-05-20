import type { Snippet } from "svelte";

let content = $state<Snippet | undefined>(undefined);

export const navbar = {
  get content() {
    return content;
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
