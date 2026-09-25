/**
 * Framework-agnostic sync primitives for the Roomy appserver.
 *
 * Exports:
 *  - `SyncConnection`: WebSocket state machine with ticket auth, reconnect,
 *    and CBOR frame decoding.
 *  - `SyncRouter` and `TopicManager`: frame-to-cache invalidation routing and
 *    refcounted topic subscriptions.
 */

export {
  SyncConnection,
  decodeCborFrame,
  type ConnectionLogger,
  type ConnectionStatus,
  type GiveUpInfo,
  type CloseEventInfo,
  type SyncConnectionOptions,
  type SyncFrame,
  type Topic,
  type TopicKind,
  type Unsubscribe,
} from "./connection";

// Invalidation router + refcounted topic subscriptions.
export { SyncRouter, type SyncRouterOptions } from "./router";
export { TopicManager } from "./topics";
export { applyMessageDiff, type Message, type MessageDiffOp } from "./diff";
export {
  patchRoomMetadata,
  patchSpaces,
  patchSpaceMetadata,
} from "./roomMetadataDiff";
export {
  patchSpaceBoard,
  patchRoomBoard,
  patchRecentThreads,
  patchSpaceBoardUnread,
  patchRoomBoardUnread,
  type RoomActivityPatch,
} from "./roomActivityDiff";
