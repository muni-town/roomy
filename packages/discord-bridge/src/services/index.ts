/**
 * Domain-based sync services for Discord ↔ Roomy bridge.
 *
 * This package provides cohesive, testable services organized by domain:
 * - ProfileSyncService: User profile syncing (Discord → Roomy)
 * - ReactionSyncService: Reaction syncing (bidirectional)
 * - MessageSyncService: Message syncing (bidirectional)
 * - StructureSyncService: Room structure syncing (channels, threads, links, sidebar)
 * - SyncOrchestrator: Top-level coordinator
 *
 * All services depend on BridgeRepository and ConnectedSpace,
 * keeping them testable with mocks.
 */

export { ProfileSyncService } from "./ProfileSyncService.js";
export type { DiscordUser } from "./ProfileSyncService.js";

export { ReactionSyncService } from "./ReactionSyncService.js";

export { StructureSyncService } from "./StructureSyncService.js";

export { MessageSyncService } from "./MessageSyncService.js";
export type {
  DiscordToRoomyResult,
  EventBatcher,
} from "./MessageSyncService.js";

export {
  Bridge as SyncOrchestrator,
  createSyncOrchestrator,
} from "./SyncOrchestrator.js";
