import { LatestMessages, SyncedIds } from "./db";

export type GuildContext = {
  guildId: bigint;
  syncedIds: SyncedIds;
  // space: co.loaded<typeof RoomyEntity>;
  // groups: LoadedSpaceGroups;
  latestMessagesInChannel: LatestMessages;
};
