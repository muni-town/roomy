import {
  DiscordMessageHashes,
  LatestMessages,
  SyncedEdits,
  SyncedIds,
  SyncedProfiles,
  SyncedReactions,
  SyncedRoomLinks,
  SyncedSidebarHash,
} from "./db";
import type { ConnectedSpace } from "@roomy/sdk";

export type GuildContext = {
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
