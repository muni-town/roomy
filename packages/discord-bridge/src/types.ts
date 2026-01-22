import { LatestMessages, SyncedIds } from "./db";
import type { ConnectedSpace } from "@roomy/sdk";

export type GuildContext = {
  guildId: bigint;
  spaceId: string;
  syncedIds: SyncedIds;
  latestMessagesInChannel: LatestMessages;
  connectedSpace: ConnectedSpace;
};
