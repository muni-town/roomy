/**
 * Feature flag registry.
 *
 * The source of truth for which flags exist. Add new flags to the
 * `FEATURE_FLAGS` array. The DB stores *state* (global on/off, per-user
 * assignments); this module defines *identity* (which keys are valid).
 *
 * All flags default to false for all users. An admin can enable a flag
 * globally (all users) or for specific DIDs via the admin XRPC endpoints.
 */

export interface FeatureFlagDef {
  key: string;
  description: string;
}

/**
 * Registered feature flags. Add new entries here.
 * The key is used as the XRPC flag identifier and DB primary key.
 */
export const FEATURE_FLAGS: readonly FeatureFlagDef[] = [
  { key: "push-notifications", description: "Enable push notification delivery and subscription" },
];
export const FEATURE_FLAG_KEYS: ReadonlySet<string> = new Set(
  FEATURE_FLAGS.map((f) => f.key),
);

/**
 * Look up a flag definition by key, or undefined if not registered.
 */
export function getFlagDef(key: string): FeatureFlagDef | undefined {
  return FEATURE_FLAGS.find((f) => f.key === key);
}
