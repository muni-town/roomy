import type { Snippet } from "svelte";

let content = $state<Snippet | undefined>(undefined);

export const sidebarOverride = {
  get content() {
    return content;
  },
};

/**
 * Override the space sidebar from a nested route (e.g. settings). When set, the
 * space layout renders this snippet in place of the default `SpaceSidebar`.
 * Pages should call this inside an `$effect` and clear it on cleanup so stale
 * content doesn't linger after navigation:
 *
 *   $effect(() => {
 *     setSidebar(mySidebarSnippet);
 *     return () => setSidebar(undefined);
 *   });
 */
export function setSidebar(snippet: Snippet | undefined) {
  content = snippet;
}
