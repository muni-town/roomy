/**
 * Event Schema
 *
 * This module provides ArkType definitions for Roomy events.
 *
 * Usage:
 * ```ts
 * import { event, parseEvent } from './schema';
 * import { decode } from '@atcute/cbor';
 *
 * // Decode DRISL bytes to plain object
 * const decoded = decode(bytes);
 *
 * // Validate and parse with ArkType
 * const result = parseEvent(decoded.event);
 * if (result.success) {
 *   switch (result.data.$type) {
 *     case 'space.roomy.room.sendMessage':
 *       // TypeScript knows the shape here
 *       console.log(result.data.content);
 *       break;
 *   }
 * }
 * ```
 */

// Primitives
export * from "./primitives";

// Envelope
export { Event, EventVariant, parseEvent, type EventType } from "./envelope";
