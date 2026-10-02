/**
 * Query-param stringification shared by the XRPC transports.
 *
 * XRPC query params travel in the URL, so every value the caller hands in is
 * coerced to a string. The coercion is strict about *shape*: only scalars have
 * a string form the server can mean anything by. A non-scalar does not fail —
 * it silently becomes a plausible-looking string that names no entity:
 *
 *   String({})             -> "[object Object]"
 *   String(["abc"])        -> "abc"          (a one-element array looks real)
 *   String(["a", "b"])     -> "a,b"
 *
 * Those reach the appserver as a `spaceId` / `roomId` and come back as
 * `404 Space not found: [object Object]` — a log line that reads like a
 * missing entity rather than the caller bug it is. Rejecting the value here
 * keeps the error at the boundary that produced it, before any request is
 * issued and before the service-auth token is fetched.
 *
 * `undefined` / `null` are skipped, which is how optional params are omitted.
 */

/** The scalar shapes an XRPC query param may legitimately be. */
function isScalar(value: unknown): value is string | number | boolean | bigint {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  );
}

/** A human name for a non-scalar value, for the error message. */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  const ctor = (value as { constructor?: { name?: string } } | null)
    ?.constructor?.name;
  return ctor && ctor !== "Object" ? `a ${ctor}` : "an object";
}

/**
 * Coerce `params` to the string map an XRPC request carries.
 *
 * Throws a `TypeError` naming the NSID and the offending param when a value is
 * not a scalar, rather than letting it stringify into an id-shaped request.
 */
export function stringifyParams(
  nsid: string,
  params: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (!isScalar(value)) {
      throw new TypeError(
        `XRPC ${nsid}: param "${key}" must be a string, got ${shapeOf(value)}. ` +
          `Coercing it would send "${String(value)}" as ${key}.`,
      );
    }
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}
