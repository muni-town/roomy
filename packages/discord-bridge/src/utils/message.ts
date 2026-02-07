/**
 * Message-related utility functions for data transformation.
 * All functions in this module are pure (no side effects).
 */

import type { Event } from "@roomy/sdk";

/**
 * Decode message body data from a Roomy event.
 * Handles both Uint8Array and base64-encoded string formats.
 *
 * @param event - Roomy event object
 * @returns Decoded string content, or empty string if no data
 *
 * @example
 * ```ts
 * // With Uint8Array data
 * decodeMessageBody({ body: { data: new Uint8Array([72, 105, 33]) } })
 * // => "Hi!"
 *
 * // With base64-encoded data
 * decodeMessageBody({ body: { data: { $bytes: "SGVsbG8h" } } })
 * // => "Hello!"
 *
 * // With no data
 * decodeMessageBody({ body: {} })
 * // => ""
 * ```
 */
export function decodeMessageBody(event: Event): string {
  const createMessageEvent = event as { body?: { data: { $bytes?: string } | Uint8Array } };
  const data = createMessageEvent.body?.data;
  if (!data) return "";
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  const bytesData = data as { $bytes?: string };
  if (bytesData.$bytes) {
    // Decode base64 to binary string, then convert to Uint8Array for proper UTF-8 decoding
    const binaryString = atob(bytesData.$bytes);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  return "";
}
