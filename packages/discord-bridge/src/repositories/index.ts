/**
 * Repository exports and factory functions.
 */

export type { BridgeRepository } from "./BridgeRepository.js";
export { LevelDBBridgeRepository } from "./BridgeRepository.js";
export type { RoomLink, WebhookToken } from "./BridgeRepository.js";
export type { RoomyUserProfile, SyncedEdit } from "../db.js";

export { MockBridgeRepository } from "./MockBridgeRepository.js";

import type { GuildContext } from "../types.js";
import type { DiscordBot } from "../discord/types.js";
import { LevelDBBridgeRepository } from "./BridgeRepository.js";
import {
  roomyUserProfilesForBridge,
  discordWebhookTokensForBridge,
} from "../db.js";
import { createSyncOrchestrator, type SyncOrchestrator } from "../services/SyncOrchestrator.js";

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

/**
 * Create a SyncOrchestrator from a GuildContext.
 * Bridges the old GuildContext pattern to the new service architecture.
 *
 * @param ctx - Guild context containing database stores
 * @param bot - Optional Discord bot instance (needed for thread starter message fetching)
 * @returns Configured SyncOrchestrator
 *
 * @example
 * ```ts
 * const orchestrator = createOrchestratorFromContext(ctx, bot);
 * await orchestrator.handleDiscordMessageCreate(message, roomyRoomId);
 * ```
 */
export function createOrchestratorFromContext(ctx: GuildContext, bot?: DiscordBot): SyncOrchestrator {
  const repo = createBridgeRepository(ctx);
  return createSyncOrchestrator({
    repo,
    connectedSpace: ctx.connectedSpace,
    guildId: ctx.guildId,
    spaceId: ctx.spaceId,
    bot,
  });
}
