/**
 * A navigation destination within a space.
 *
 * - `{ kind: "room", id }` — a specific channel or thread
 * - `{ kind: "index" }` — the space home page (threads view)
 * - Future: `{ kind: "settings" }`, `{ kind: "members" }`, etc.
 */
export type Destination =
  | { kind: "room"; id: string }
  | { kind: "index" };

/**
 * Reactive store of the last destination per space.
 *
 * Stores where the user was in each space so the server bar and space
 * switcher can redirect back there when re-entering the space.
 *
 * Updated by the [room] page and [space] index page, and future special pages.
 * Read by the server bar / sidebar when navigating to a space.
 *
 * The channel/threads tab is deliberately NOT stored here: it is per-entry
 * state (a channel always opens in Chat view), so it never crosses rooms or
 * page loads.
 */

const destinationBySpace = $state(new Map<string, Destination>());

export const spaceNavigation = {
  /** Get the stored destination for a space, if any. */
  get(spaceId: string): Destination | undefined {
    return destinationBySpace.get(spaceId);
  },
  /** Set the stored destination for a space. */
  set(spaceId: string, destination: Destination) {
    destinationBySpace.set(spaceId, destination);
  },
};
