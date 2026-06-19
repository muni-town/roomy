/**
 * A navigation destination within a space.
 *
 * - `{ kind: "room", id }` — a specific channel or thread
 * - `{ kind: "index" }` — the space home page (Feed / Threads)
 * - Future: `{ kind: "settings" }`, `{ kind: "members" }`, etc.
 */
export type Destination =
  | { kind: "room"; id: string }
  | { kind: "index" };

/** The view mode for pages that have a chat/feed vs threads toggle. */
export type ViewMode = "chat" | "threads";

export interface SpaceNavigationState {
  destination: Destination;
  viewMode: ViewMode;
}

/**
 * Reactive state for per-space navigation preferences.
 *
 * Stores a single `SpaceNavigationState` per space, combining:
 * - `destination` — where to redirect when switching to this space
 *   (a room, the index, or future special pages)
 * - `viewMode` — whether the user was in chat/feed or threads view
 *   (shared between the space index and channel pages)
 *
 * Updated by the [room] page, [space] index page, and future special pages.
 * Read by the server bar when navigating to a space, and by both pages
 * on mount to restore the previous view mode.
 */

const stateBySpace = $state(new Map<string, SpaceNavigationState>());

export const spaceNavigation = {
  /** Get the stored navigation state for a space, if any. */
  get(spaceId: string): SpaceNavigationState | undefined {
    return stateBySpace.get(spaceId);
  },
  /** Set the stored navigation state for a space. */
  set(spaceId: string, state: SpaceNavigationState) {
    stateBySpace.set(spaceId, state);
  },
};
