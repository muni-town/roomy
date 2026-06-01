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

/**
 * Reverse discordeno's iconHashToBigInt: strips the prefix ('b' for static,
 * 'a' for animated → prepends 'a_') to recover the original CDN hash string.
 */
export function iconBigintToHash(icon: bigint): string {
  const hex = icon.toString(16);
  return hex.startsWith("a") ? `a_${hex.substring(1)}` : hex.substring(1);
}
