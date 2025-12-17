/**
 * Schema registry: central mapping of all event types.
 *
 * This registry is used by:
 * 1. Runtime parsing (look up schema by $type)
 * 2. Lexicon generation (iterate all schemas with metadata)
 */

import type { Type } from "arktype";
import { events as messageEvents } from "./events/message";
import { events as roomEvents } from "./events/room";
import { extensions as messageExtensions } from "./extensions/message";

export interface SchemaEntry {
  type: Type<any>;
  description: string;
}

// All event schemas
export const eventSchemas: Record<string, SchemaEntry> = {
  ...messageEvents,
  ...roomEvents,
  // Add other event families as they're defined
};

// All extension schemas (for nested unions)
export const extensionSchemas: Record<string, SchemaEntry> = Object.fromEntries(
  Object.entries(messageExtensions).map(([nsid, type]) => [
    nsid,
    { type, description: "" }, // Add descriptions as needed
  ]),
);

// Combined registry for lexicon generation
export const allSchemas: Record<string, SchemaEntry> = {
  ...eventSchemas,
  ...extensionSchemas,
};

/**
 * Parse an event variant by looking up its $type.
 *
 * Usage:
 * ```ts
 * const decoded = drisl.decode(bytes);
 * const result = parseEvent(decoded);
 * if (result.success) {
 *   // result.data is fully typed
 * }
 * ```
 */
export function parseEvent(data: unknown) {
  if (typeof data !== "object" || data === null || !("$type" in data)) {
    return { success: false as const, error: "Missing $type field" };
  }

  const $type = (data as { $type: unknown }).$type;
  if (typeof $type !== "string") {
    return { success: false as const, error: "$type must be a string" };
  }

  const schema = eventSchemas[$type];
  if (!schema) {
    return { success: false as const, error: `Unknown event type: ${$type}` };
  }

  const result = schema.type(data);
  if (result instanceof type.errors) {
    return { success: false as const, error: result.summary };
  }

  return { success: true as const, data: result };
}

// Need to import type for the error check
import { type } from "arktype";
