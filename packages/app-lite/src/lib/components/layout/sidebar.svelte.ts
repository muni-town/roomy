import type { Snippet } from "svelte";

let content = $state<Snippet | undefined>(undefined);
let overrideContent = $state<Snippet | undefined>(undefined);
let headerContent = $state<Snippet | undefined>(undefined);

export const sidebarOverride = {
  get content() {
    return overrideContent;
  },
};

export const sidebarContent = {
  get content() {
    return content;
  },
};

export const sidebarHeader = {
  get content() {
    return headerContent;
  },
};

/**
 * Set the sidebar content from a page/layout. Pages should call this inside an
 * `$effect` and clear it on cleanup:
 *
 *   $effect(() => {
 *     setSidebarContent(mySidebar);
 *     return () => setSidebarContent(undefined);
 *   });
 */
export function setSidebarContent(snippet: Snippet | undefined) {
  content = snippet;
}

/**
 * Override the space sidebar from a nested route (e.g. settings). When set,
 * it takes precedence over the default sidebar content.
 * Pages should call this inside an `$effect` and clear it on cleanup:
 *
 *   $effect(() => {
 *     setSidebar(mySidebarSnippet);
 *     return () => setSidebar(undefined);
 *   });
 */
export function setSidebar(snippet: Snippet | undefined) {
  overrideContent = snippet;
}

/**
 * Set the full-width sidebar header (typically the SpaceHeaderShell). Rendered
 * by MainLayout above the server bar / BigSidebar row so it can span the whole
 * sidebar width, matching the user card. Pages/components should call this
 * inside an `$effect` and clear it on cleanup:
 *
 *   $effect(() => {
 *     setSidebarHeader(myHeader);
 *     return () => setSidebarHeader(undefined);
 *   });
 */
export function setSidebarHeader(snippet: Snippet | undefined) {
  headerContent = snippet;
}
