import type { co, RoomyEntity } from "@roomy-chat/sdk";

export type LoadedSpace = {
  space: co.loaded<typeof RoomyEntity>;
  members?: { value: string; label: string }[];
};
