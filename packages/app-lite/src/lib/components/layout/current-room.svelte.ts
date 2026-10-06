/**
 * Reactive state for the currently active room (set by the [room] page).
 * Used by NavbarSpaceInfo to show the room icon + name alongside the space avatar.
 */
export interface CurrentRoomInfo {
  id: string;
  name: string;
  /** A voice room has no message timeline; the navbar marks it as a call. */
  kind: "channel" | "thread" | "voice";
  /** The channel this thread belongs to (only for threads). */
  parentChannelId?: string;
  parentChannelName?: string;
  /** Set for channels federated into this space from another (origin) space. */
  federatedOrigin?: {
    id: string;
    name?: string;
    avatar?: string;
  };
}

let currentRoom = $state<CurrentRoomInfo | null>(null);

export const currentRoomState = {
  get value() {
    return currentRoom;
  },
};

export function setCurrentRoom(info: CurrentRoomInfo | null) {
  currentRoom = info;
}