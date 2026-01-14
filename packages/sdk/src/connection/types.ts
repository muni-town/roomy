/**
 * Types for the ConnectedSpace connection module.
 */

import type { Agent } from "@atproto/api";
import type { StreamDid, StreamIndex, UserDid, Event } from "../schema";
import type { ModuleWithCid } from "../modules";
import { LeafClient } from "@muni-town/leaf-client";

/**
 * Configuration for connecting to a Roomy space.
 */
export interface ConnectedSpaceConfig {
  /** ATProto agent for authentication */
  agent: Agent;
  /** Client for the Leaf server */
  leaf: LeafClient;
  /** DID of the stream (space) to connect to */
  streamDid: StreamDid;
  /** Module definition for the space */
  module: ModuleWithCid;
}

/**
 * A decoded stream event with metadata.
 */
export interface DecodedStreamEvent {
  /** Index of this event in the stream */
  idx: StreamIndex;
  /** The parsed event data */
  event: Event;
  /** DID of the user who created this event */
  user: UserDid;
}

/**
 * Metadata passed to event callbacks.
 */
export interface EventCallbackMeta {
  /** Whether these events are from backfill (historical) or live */
  isBackfill: boolean;
  /** The stream these events came from */
  streamDid: StreamDid;
}

/**
 * Callback function for receiving events.
 */
export type EventCallback = (
  events: DecodedStreamEvent[],
  meta: EventCallbackMeta,
) => void;

/**
 * Status of the backfill process.
 */
export type BackfillStatus =
  | { status: "pending" }
  | { status: "started" }
  | { status: "finished" }
  | { status: "errored"; error: string };

/**
 * Encoded stream event as received from Leaf.
 */
export interface EncodedStreamEvent {
  idx: StreamIndex;
  user: UserDid;
  payload: Uint8Array;
}
