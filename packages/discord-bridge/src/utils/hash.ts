/**
 * Hash-related utility functions for change detection and idempotency.
 * All functions in this module are pure (no side effects).
 */

import { createHash } from "node:crypto";
import type { Ulid } from "@roomy/sdk";

/**
 * Compute a collision-resistant fingerprint from arbitrary string data.
 * Uses SHA-256 and returns a 32-character hex string (128 bits).
 *
 * @param data - Input string to hash
 * @returns 32-character hex string (first 128 bits of SHA-256)
 *
 * @example
 * ```ts
 * fingerprint("test-data") // => "916f0023..."
 * ```
 */
export function fingerprint(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

/**
 * Compute a fingerprint from Discord user profile data.
 * Used for change detection to avoid redundant profile updates.
 *
 * @param username - Discord username
 * @param globalName - Discord display name (nullable)
 * @param avatar - Discord avatar hash (nullable)
 * @returns 32-character hex string for comparison
 *
 * @example
 * ```ts
 * computeProfileHash("user", "Display Name", "abc123")
 * // => "a1b2c3d4..."
 * ```
 */
export function computeProfileHash(
  username: string,
  globalName: string | null,
  avatar: string | null,
): string {
  const data = `${username}|${globalName ?? ""}|${avatar ?? ""}`;
  return fingerprint(data);
}

/**
 * Compute a fingerprint from sidebar structure for change detection.
 * Normalizes the structure by sorting categories and children for consistency.
 *
 * @param categories - Array of categories with child room ULIDs
 * @returns 32-character hex string for comparison
 *
 * @example
 * ```ts
 * computeSidebarHash([
 *   { name: "General", children: ["ulid1", "ulid2"] }
 * ])
 * // => "e5f6g7h8..."
 * ```
 */
export function computeSidebarHash(
  categories: { id?: Ulid; name: string; children: Ulid[] }[],
): string {
  // Sort categories by name and children by value for consistent hashing
  const normalized = categories
    .map((c) => ({
      ...(c.id && { id: c.id }),
      name: c.name,
      children: [...c.children].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return fingerprint(JSON.stringify(normalized));
}

/**
 * Compute a fingerprint from message content and attachments for edit change detection.
 * Normalizes attachments by sorting their URLs for consistent hashing.
 *
 * @param content - Message content (markdown/text)
 * @param attachments - Array of attachments with URLs
 * @returns 32-character hex string for comparison
 *
 * @example
 * ```ts
 * computeEditHash("Hello", [{ url: "https://example.com/img.png" }])
 * // => "i9j0k1l2..."
 * ```
 */
export function computeEditHash(
  content: string,
  attachments: { url: string }[],
): string {
  const data = JSON.stringify({
    content,
    attachments: attachments.map((a) => a.url).sort(),
  });
  return fingerprint(data);
}
