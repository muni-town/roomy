/**
 * Repository exports and factory functions.
 */

export {
  BridgeRepository,
  LevelDBBridgeRepository,
  type RoomLink,
  type WebhookToken,
  type RoomyUserProfile,
  type SyncedEdit,
} from "./BridgeRepository.js";

export { MockBridgeRepository } from "./MockBridgeRepository.js";

import type { GuildContext } from "../types.js";
import { LevelDBBridgeRepository } from "./BridgeRepository.js";
import {
  roomyUserProfilesForBridge,
  discordWebhookTokensForBridge,
} from "../db.js";

/**
 * Create a BridgeRepository from a GuildContext.
 * This is the main factory function for getting a repository instance.
 *
 * @param ctx - Guild context containing database stores
 * @returns BridgeRepository backed by LevelDB
 *
 * @example
 * ```ts
 * const repo = createBridgeRepository(ctx);
 * const roomyId = await repo.getRoomyId(discordId);
 * ```
 */
export function createBridgeRepository(ctx: GuildContext): LevelDBBridgeRepository {
  // Create stores that aren't in GuildContext
  const roomyUserProfiles = roomyUserProfilesForBridge({
    discordGuildId: ctx.guildId,
    roomySpaceId: ctx.spaceId,
  });
  const discordWebhookTokens = discordWebhookTokensForBridge({
    discordGuildId: ctx.guildId,
    roomySpaceId: ctx.spaceId,
  });

  return new LevelDBBridgeRepository({
    syncedIds: ctx.syncedIds,
    syncedProfiles: ctx.syncedProfiles,
    roomyUserProfiles,
    syncedReactions: ctx.syncedReactions,
    syncedSidebarHash: ctx.syncedSidebarHash,
    syncedRoomLinks: ctx.syncedRoomLinks,
    syncedEdits: ctx.syncedEdits,
    discordWebhookTokens,
    discordMessageHashes: ctx.discordMessageHashes,
    discordLatestMessage: ctx.latestMessagesInChannel,
  });
}
