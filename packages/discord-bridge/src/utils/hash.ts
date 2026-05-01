import { createHash } from "node:crypto";

/**
 * Collision-resistant fingerprint from arbitrary string data.
 * SHA-256 truncated to 32 hex chars (128 bits).
 */
export function fingerprint(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

/**
 * Fingerprint a Discord user profile for change detection.
 */
export function computeProfileHash(
  username: string,
  globalName: string | null,
  avatar: string | null,
): string {
  const data = `${username}|${globalName ?? ""}|${avatar ?? ""}`;
  return fingerprint(data);
}
