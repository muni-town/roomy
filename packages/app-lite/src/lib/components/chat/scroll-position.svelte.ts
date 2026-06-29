/**
 * Scroll position state manager for channels and threads.
 * Persists scroll offset per room so users are restored to their last
 * position when navigating back to a channel/thread.
 */

export interface ScrollPosition {
  /** Scroll offset in pixels from the top */
  offset: number;
  /** Whether the user was at the bottom (newest messages) */
  atBottom: boolean;
  /** Timestamp of last scroll event */
  timestamp: number;
}

const scrollPositions = $state(new Map<string, ScrollPosition>());

export const scrollPositionState = {
  /** Get the stored scroll position for a room, if any. */
  get(roomId: string): ScrollPosition | undefined {
    const pos = scrollPositions.get(roomId);
    return pos;
  },

  /** Update the stored scroll position for a room. */
  set(roomId: string, position: ScrollPosition) {
    const updated = { ...position, timestamp: Date.now() };
    scrollPositions.set(roomId, updated);
  },

  /** Clear the stored scroll position for a room (e.g., when user scrolls to bottom). */
  clear(roomId: string) {
    scrollPositions.delete(roomId);
  },

  /** Clear all stored scroll positions. */
  clearAll() {
    scrollPositions.clear();
  },

  /** Get all stored scroll positions. */
  getAll(): Map<string, ScrollPosition> {
    return new Map(scrollPositions);
  },
};

/**
 * Persist scroll positions to localStorage so they survive page refreshes.
 * Call this on app initialization to restore persisted positions.
 */
export function restoreScrollPositionsFromStorage() {
  try {
    const stored = localStorage.getItem("roomy-scroll-positions");
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, ScrollPosition>;
      for (const [roomId, position] of Object.entries(parsed)) {
        // Only restore positions from the last 24 hours to avoid stale data
        if (Date.now() - position.timestamp < 24 * 60 * 60 * 1000) {
          scrollPositions.set(roomId, position);
        }
      }
    }
  } catch (e) {
    console.warn("Failed to restore scroll positions from storage:", e);
  }
}

/**
 * Save current scroll positions to localStorage.
 * Call this before page unload or periodically.
 */
export function saveScrollPositionsToStorage() {
  try {
    const positions: Record<string, ScrollPosition> = {};
    for (const [roomId, position] of scrollPositions) {
      positions[roomId] = position;
    }
    localStorage.setItem("roomy-scroll-positions", JSON.stringify(positions));
  } catch (e) {
    console.warn("Failed to save scroll positions to storage:", e);
  }
}
