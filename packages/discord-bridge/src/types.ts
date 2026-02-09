import type { ConnectedSpace } from "@roomy/sdk";
import type { LatestMessages } from "./repositories/db";
import type { SyncOrchestrator } from "./services/SyncOrchestrator";
import type { BridgeRepository } from "./repositories";

/**
 * Context for handling Discord events in a guild.
 * Provides the orchestrator for sync operations, repository for queries,
 * and cursor tracking for backfill.
 */
export type OrchestratorContext = {
  /** Sync orchestrator for all Discord ↔ Roomy operations */
  orchestrator: SyncOrchestrator;
  /** Repository for ID mapping and data access */
  repo: BridgeRepository;
  /** Latest message tracking per channel (for backfill cursor) */
  latestMessagesInChannel: LatestMessages;
  /** Connected Roomy space */
  connectedSpace: ConnectedSpace;
  /** Discord guild ID */
  guildId: bigint;
  /** Roomy space ID */
  spaceId: string;
};
