import {
  DiscordMessageHashes,
  LatestMessagBridge
  SyncedEdits,
  SyncedIds,
  SyncedProfiles,
  SyncedReactions,
  SyncedRoomLinks,
  SyncedSidebarHash,
} from "./repositories/db";
import type { ConnectedSpace } from "@roomy/sdk";

export type GuilBridge
  guildId: bigint;
  spaceId: string;
  syncedIds: SyncedIds;
  latestMessagesInChannel: LatestMessages;
  syncedProfiles: SyncedProfiles;
  syncedReactions: SyncedReactions;
  syncedSidebarHash: SyncedSidebarHash;
  syncedRoomLinks: SyncedRoomLinks;
  syncedEdits: SyncedEdits;
  discordMessageHashes: DiscordMessageHashes;
  connectedSpace: ConnectedSpace;
};
