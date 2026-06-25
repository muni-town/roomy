/**
 * Reactive state for the space selector overlay visibility.
 *
 * On space pages, the space selector is a wide (homepage-style) panel that
 * overlays the BigSidebar when expanded, and is hidden when collapsed. It is
 * toggled via the space header (clicking the avatar/header area) and auto-
 * closes after picking a space. On the homepage the wide server bar is always
 * shown inline, so this state is irrelevant there.
 */
let expanded = $state(false);

export const serverBar = {
  get expanded() {
    return expanded;
  },
  set expanded(v: boolean) {
    expanded = v;
  },
};

export function toggleServerBar() {
  expanded = !expanded;
}
