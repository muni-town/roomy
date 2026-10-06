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
  {
    key: "search",
    description:
      "Enable search UI: member search, thread search, and cross-space Explore",
  },
  {
    key: "space-account-management",
    description:
      "Arbiter-powered space account management: space handle settings and Bluesky profile integration",
  },
  {
    key: "pro-subscription",
    description:
      "Roomy Pro subscription page in user settings: Polar checkout link and membership status",
  },
  {
    key: "links-view",
    description:
      "Per-room and per-space link aggregation links view (third channel tab)",
  },
  {
    key: "semble-integration",
    description:
      "Semble integration: create network.cosmik.card space cards from chat message links",
  },
  {
    key: "access-settings",
    description:
      "User account access settings page: view and change which PDS OAuth scopes Roomy is granted",
  },
  {
    key: "user-blocks",
    description:
      "Per-user blocking: the Block action on a profile, behind enforcement on the read path",
  },
  {
    key: "voice-chat",
    description:
      "Voice rooms: the sidebar's call list and the room's call panel",
  },
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
