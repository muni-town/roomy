/**
 * Reactive state for the currently active room (set by the [room] page).
 * Used by NavbarSpaceInfo to show the room icon + name alongside the space avatar.
 */
export interface CurrentRoomInfo {
  id: string;
  name: string;
  kind: "channel" | "thread";
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