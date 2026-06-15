/**
 * Reactive state for the space switcher (picker) shown inside SpaceSidebar.
 *
 * The picker is rendered by SpaceSidebar, but triggered from the sidebar
 * bottom tabs. This shared store lets the bottom tab toggle the picker and
 * reflect its active state without prop-drilling.
 *
 * Follows the same pattern as navbar.svelte.ts / sidebar.svelte.ts.
 *
 * Note: when there is no active space (homepage), SpaceSidebar always shows
 * the picker regardless of this flag.
 */
let open = $state(false);

export const spacePicker = {
  get open() {
    return open;
  },
  set open(v: boolean) {
    open = v;
  },
};

/** Close the space picker. */
export function closeSpacePicker() {
  open = false;
}
