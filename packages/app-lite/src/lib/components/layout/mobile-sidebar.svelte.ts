/**
 * Reactive state for mobile sidebar visibility.
 * Follows the same pattern as navbar.svelte.ts / sidebar.svelte.ts.
 */

let visible = $state(false);

export const mobileSidebar = {
  get visible() {
    return visible;
  },
  set visible(v: boolean) {
    visible = v;
  },
};