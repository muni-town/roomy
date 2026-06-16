/**
 * Reactive state for the sidebar layout mode.
 *
 * Pages that want the homepage-style layout (wide server bar filling the
 * sidebar area, no BigSidebar) can call `setWideSidebar(true)` in their
 * `$effect` and clear it on cleanup.
 *
 * This keeps the layout logic in one place — when the expanded sidebar
 * design evolves, only `MainLayout.svelte` and this module need changes.
 */

let wide = $state(false);

export const wideSidebar = {
  get active() {
    return wide;
  },
};

export function setWideSidebar(active: boolean) {
  wide = active;
}
