/**
 * Reactive state for the settings panel overlay visibility.
 *
 * On space pages, the settings panel is a sidebar panel that slides in from
 * the RIGHT (mirroring the space selector / directory, which slides in from
 * the left) while the channels body slides out to the left. The space header
 * and space action buttons stay intact — only the channels body moves — so
 * the directory, spaces, and settings read as one unified, pannable sidebar.
 *
 * It is opened by entering a `/{space}/settings` route (the settings layout
 * sets `expanded = true` on mount and clears it on unmount) and closed by
 * leaving that route (e.g. the "Back to space" button or the settings toggle
 * in the action buttons).
 */
let expanded = $state(false);

export const settingsBar = {
  get expanded() {
    return expanded;
  },
  set expanded(v: boolean) {
    expanded = v;
  },
};

export function toggleSettingsBar() {
  expanded = !expanded;
}