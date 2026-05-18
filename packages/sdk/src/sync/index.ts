/**
 * Framework-agnostic sync primitives for the Roomy appserver.
 *
 * Currently exports:
 *  - `SyncConnection`: WebSocket state machine with ticket auth, reconnect,
 *    and CBOR frame decoding.
 *
 * Higher-level pieces (invalidation router, topic refcounting) will land in
 * subsequent slices of the SDK thin-client extraction plan.
 */

export {
  SyncConnection,
  decodeCborFrame,
  type ConnectionLogger,
  type ConnectionStatus,
  type CloseEventInfo,
  type SyncConnectionOptions,
  type SyncFrame,
  type Topic,
  type TopicKind,
  type Unsubscribe,
} from "./connection";

// Slice 6: invalidation router + refcounted topic subscriptions.
export { SyncRouter, type SyncRouterOptions } from "./router";
export { TopicManager } from "./topics";
export { applyMessageDiff, type Message, type MessageDiffOp } from "./diff";
