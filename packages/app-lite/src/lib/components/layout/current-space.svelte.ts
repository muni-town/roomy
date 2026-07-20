/**
 * Reactive state for the currently active space (set by the [space] layout).
 * Used by RoomyHomeCard to show space avatar + name on mobile instead of
 * the "Roomy" text label.
 */
export interface CurrentSpaceInfo {
  id: string;
  name?: string;
  avatar?: string;
}

let currentSpace = $state<CurrentSpaceInfo | null>(null);

export const currentSpaceState = {
  get value() {
    return currentSpace;
  },
};

/**
 * Set the current space info from a space layout. Call inside $effect and
 * clear on cleanup so stale data doesn't linger after navigation:
 *
 *   $effect(() => {
 *     setCurrentSpace(spaceInfo);
 *     return () => setCurrentSpace(null);
 *   });
 */
export function setCurrentSpace(info: CurrentSpaceInfo | null) {
  currentSpace = info;
}

/**
 * Tracks the last space the user was in, even after leaving the space layout.
 * Used by the user settings "Back" button to return to the last-visited space/room.
 */
let lastActiveSpaceId = $state<string | null>(null);

export const lastActiveSpaceIdState = {
  get value() {
    return lastActiveSpaceId;
  },
};

export function setLastActiveSpaceId(id: string | null) {
  lastActiveSpaceId = id;
}
