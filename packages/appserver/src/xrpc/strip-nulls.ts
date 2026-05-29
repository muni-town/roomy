/**
 * Strip null values from an object (shallow).
 *
 * AT Protocol lexicons model optional fields as "absent or present with
 * value" — `null` is never valid for a `type: "string"` property. Use this
 * helper on response objects before returning them so that `null` DB values
 * become absent keys, matching the lexicon wire format.
 *
 * Nested objects and arrays are passed through unchanged — only own
 * enumerable top-level keys with value `null` are dropped.
 *
 * Returns `unknown` — cast to the target type at the call site.
 */
export function stripNulls(obj: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) out[k] = v;
  }
  return out;
}
