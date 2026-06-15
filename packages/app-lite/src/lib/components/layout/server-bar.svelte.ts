/**
 * Reactive state for the server bar (thin space-switcher bar) visibility.
 *
 * The server bar is a Discord-style thin column to the left of the channel
 * sidebar showing space avatars for quick switching. It can be collapsed
 * and expanded via the collapse-sidebar button in the space header.
 */
let expanded = $state(true);

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
