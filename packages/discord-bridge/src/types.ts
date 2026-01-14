import { LatestMessages, SyncedIds } from "./db";

export type GuildContext = {
  guildId: bigint;
  syncedIds: SyncedIds;
  spaceId?: string; // DID
  latestMessagesInChannel: LatestMessages;
};
