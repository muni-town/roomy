/** Default feature flags, can be overridden per environment with
 * VITE_FEATURE_FLAGS env var as JSON string.
 */
const baseFlags = {
  threadsList: true, // 'Index' (threads list) page for spaces
};

type Flags = typeof baseFlags;

function loadFlags(): Flags {
  const overrides = import.meta.env.VITE_FEATURE_FLAGS;
  if (!overrides) return baseFlags;

  try {
    return { ...baseFlags, ...JSON.parse(overrides) };
  } catch {
    console.warn("Invalid VITE_FEATURE_FLAGS JSON");
    return baseFlags;
  }
}

export const flags = loadFlags();
