/**
 * Connection module for managing Roomy space connections.
 *
 * @example
 * ```ts
 * import { ConnectedSpace } from "@roomy-space/sdk";
 *
 * const space = await ConnectedSpace.connect({
 *   agent,
 *   leafUrl: "https://leaf.example.com",
 *   leafDid: "did:web:leaf.example.com",
 *   streamDid,
 *   module: modules.space,
 * });
 *
 * await space.subscribe((events, { isBackfill }) => {
 *   for (const { event } of events) {
 *     console.log(event.$type);
 *   }
 * });
 * ```
 */

export { ConnectedSpace } from "./ConnectedSpace";
export type { ConnectionState, RoomMetadata } from "./ConnectedSpace";
export type {
  ConnectedSpaceConfig,
  DecodedStreamEvent,
  EventCallback,
  EventCallbackMeta,
  BackfillStatus,
  EncodedStreamEvent,
} from "./types";

// SQL parsing utilities
export { unwrapSqlValue, unwrapSqlRow, unwrapSqlRows } from "./sqlParsing";
export type { SqlValueToPrimitive } from "./sqlParsing";
