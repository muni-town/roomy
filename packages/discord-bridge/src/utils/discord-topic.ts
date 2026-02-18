/**
 * Discord channel topic utilities for Roomy → Discord sync idempotency.
 *
 * Uses topic-based nonce pattern: stores Roomy room ULID in Discord channel topic
 * to survive bridge restarts and prevent duplicate channel creation.
 */

import { Ulid } from "@roomy/sdk";

/**
 * Topic marker prefix for Roomy-synced channels.
 * Format: [Synced from Roomy: <room-ulid>]
 */
const ROOMY_SYNC_MARKER_PREFIX = "[Synced from Roomy: ";
const ROOMY_SYNC_MARKER_SUFFIX = "]";

/**
 * ULID regex pattern (Crockford's base32, excludes I, L, O, U)
 * 26 characters: 0-9, A-H, J-K, M-N, P-T, V-Z
 */
const ULID_PATTERN = /[0-9A-HJKMNP-TV-Z]{26}/;

/**
 * Full sync marker regex for extraction.
 */
const SYNC_MARKER_REGEX = new RegExp(
  `\\${ROOMY_SYNC_MARKER_PREFIX}(${ULID_PATTERN.source})\\${ROOMY_SYNC_MARKER_SUFFIX}`,
);

/**
 * Extract Roomy room ULID from Discord channel topic.
 *
 * @param topic - Discord channel topic (may be null/undefined)
 * @returns Roomy room ULID or null if not a synced channel
 *
 * @example
 * ```ts
 * extractRoomyRoomId("[Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]")
 * // => "01HZ5KJVM7X6YM8QPE7YV4Q0ZY"
 *
 * extractRoomyRoomId("General discussion [Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]")
 * // => "01HZ5KJVM7X6YM8QPE7YV4Q0ZY"
 *
 * extractRoomyRoomId(null)
 * // => null
 * ```
 */
export function extractRoomyRoomId(
  topic: string | null | undefined,
): Ulid | null {
  if (!topic) return null;
  const match = topic.match(SYNC_MARKER_REGEX);

  return match && match[1] && Ulid.allows(match[1])
    ? Ulid.assert(match[1])
    : null;
}

/**
 * Add Roomy sync marker to a topic, preserving existing content.
 *
 * - If topic is null/undefined, returns just the marker
 * - If topic already has a marker, replaces it (updates ULID if needed)
 * - Otherwise appends marker to existing topic
 *
 * @param topic - Existing topic (may be null/undefined)
 * @param roomyRoomId - Roomy room ULID to embed in marker
 * @returns Topic with sync marker
 *
 * @example
 * ```ts
 * addRoomySyncMarker(null, "01HZ5KJVM7X6YM8QPE7YV4Q0ZY")
 * // => "[Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]"
 *
 * addRoomySyncMarker("General discussion", "01HZ5KJVM7X6YM8QPE7YV4Q0ZY")
 * // => "General discussion [Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]"
 *
 * addRoomySyncMarker("[Synced from Roomy: OLDID]", "01HZ5KJVM7X6YM8QPE7YV4Q0ZY")
 * // => "[Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]"
 * ```
 */
export function addRoomySyncMarker(
  topic: string | null,
  roomyRoomId: string,
): string {
  const marker = `${ROOMY_SYNC_MARKER_PREFIX}${roomyRoomId}${ROOMY_SYNC_MARKER_SUFFIX}`;

  if (!topic) return marker;

  // Check if topic already has a marker
  if (extractRoomyRoomId(topic)) {
    // Replace existing marker
    return topic.replace(
      new RegExp(
        `\\${ROOMY_SYNC_MARKER_PREFIX}${ULID_PATTERN.source}\\${ROOMY_SYNC_MARKER_SUFFIX}`,
        "g",
      ),
      marker,
    );
  }

  // Append marker to existing topic
  return `${topic} ${marker}`;
}

/**
 * Check if a Discord channel was synced from Roomy.
 *
 * @param topic - Discord channel topic (may be null/undefined)
 * @returns true if channel has Roomy sync marker
 *
 * @example
 * ```ts
 * isRoomySyncedChannel("[Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]")
 * // => true
 *
 * isRoomySyncedChannel("Regular channel topic")
 * // => false
 * ```
 */
export function isRoomySyncedChannel(
  topic: string | null | undefined,
): boolean {
  return extractRoomyRoomId(topic) !== null;
}

/**
 * Remove Roomy sync marker from a topic (if present).
 * Useful for testing or manual un-syncing.
 *
 * @param topic - Topic that may contain sync marker
 * @returns Topic without marker, or original if no marker found
 *
 * @example
 * ```ts
 * removeRoomySyncMarker("General [Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]")
 * // => "General "
 * ```
 */
export function removeRoomySyncMarker(topic: string | null): string | null {
  if (!topic) return null;
  return topic.replace(
    new RegExp(
      ` ?\\${ROOMY_SYNC_MARKER_PREFIX}${ULID_PATTERN.source}\\${ROOMY_SYNC_MARKER_SUFFIX}`,
      "g",
    ),
    "",
  );
}

/**
 * Roomy URL pattern for thread sync markers.
 * Format: https://roomy.space/{space-did}/{room-ulid}
 */
const ROOMY_URL_REGEX = new RegExp(
  `https://roomy\\.space/[^/]+/(${ULID_PATTERN.source})`,
);

/**
 * Build a Roomy room URL for use in thread sync marker messages.
 */
export function buildRoomyRoomUrl(
  spaceDid: string,
  roomyRoomId: string,
): string {
  return `https://roomy.space/${spaceDid}/${roomyRoomId}`;
}

/**
 * Extract Roomy room ULID from a message containing a Roomy URL.
 * Used for thread sync recovery (threads can't have topics).
 *
 * @param content - Message content that may contain a Roomy URL
 * @returns Roomy room ULID or null
 */
export function extractRoomyRoomIdFromUrl(
  content: string | null | undefined,
): Ulid | null {
  if (!content) return null;
  const match = content.match(ROOMY_URL_REGEX);
  return match && match[1] && Ulid.allows(match[1])
    ? Ulid.assert(match[1])
    : null;
}
