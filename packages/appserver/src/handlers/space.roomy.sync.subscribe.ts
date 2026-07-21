/**
 * XRPC: space.roomy.sync.subscribe (sync).
 *
 * Multiplexed WebSocket subscription for real-time data. The SyncManager
 * owns the InvalidationRouter subscription, topic routing, and per-connection
 * state. This handler simply registers each new connection.
 */

import type { SyncHandler } from "../xrpc/types.ts";
import type { InvalidationRouter } from "../invalidation/types.ts";
import { SyncManager, setSyncManager } from "../sync/handler.ts";
import type { StreamManager } from "../streams/StreamManager.ts";

/**
 * Create the sync handler. Called once at startup — the returned handler
 * is invoked for every new WS connection.
 */
export function createSyncSubscribeHandler(
  router: InvalidationRouter,
  streamManager: StreamManager,
): SyncHandler {
  const manager = new SyncManager(router, streamManager);
  const { setSyncManager } = require("../sync/handler.ts");
  setSyncManager(manager);
  return (socket) => manager.register(socket);
}
