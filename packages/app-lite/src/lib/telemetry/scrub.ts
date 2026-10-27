/**
 * Telemetry boundary: redaction of absolute URLs from payloads, and
 * pseudonymisation of the telemetry user's DID.
 *
 * Two durable, sensitive values would otherwise reach the log store. Payloads
 * first: third-party clients put whole request URLs into error messages —
 * `@happyview/oauth-client`'s fetchHandler appends
 * `_fetch …, url: ${fullUrl}` to its thrown error, and a
 * `com.atproto.server.getServiceAuth` request carries `aud`/`exp`/`lxm` in
 * that URL. app-lite logs the raw error object at several call sites, and
 * Faro's ConsoleInstrumentation forwards every `console.*` line to the log
 * store, so the URL would be stored permanently next to browser/OS data.
 *
 * One scrub at the transport boundary covers every caller of such an error,
 * present and future, rather than trusting each `console.*` site to sanitise
 * its own arguments. The rule: an absolute URL is replaced by the host it
 * points at (`pds.example.com`). The host answers what a URL in a log line is
 * actually consulted for — which server was involved — while the path and
 * query string, which can carry a signed capability that outlives the log
 * line, are dropped.
 *
 * Identity is the same argument. A DID is a durable, cross-service identifier,
 * so telemetry names the user by a salted hash of it ({@link pseudonymiseDid})
 * rather than the identifier itself; the mapping lives here, at the boundary,
 * instead of at each call site that happens to know a DID.
 */

/** Absolute http(s)/ws(s) URLs, stopping at whitespace and quoting delimiters. */
const URL_PATTERN = /(?:https?|wss?):\/\/[^\s"'`<>()[\]{}]+/gi;

/** Sentence punctuation that ends a URL in prose rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Replace every absolute URL in `text` with the host it points at, keeping any
 * punctuation that terminated the URL in the surrounding prose.
 */
export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    const punctuation = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
    const url = punctuation ? match.slice(0, -punctuation.length) : match;
    try {
      return new URL(url).host + punctuation;
    } catch {
      // Not parseable as a URL (`https://`, `https:///x`): the text after the
      // scheme is still URL-shaped, so it cannot be kept either.
      return "<redacted-url>" + punctuation;
    }
  });
}

/**
 * Scrub every string reachable from `value`, rebuilding arrays and plain
 * objects and passing anything else (Date, Error, class instances) through
 * untouched.
 */
function scrubValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return redactUrls(value);
  if (typeof value !== "object" || value === null) return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const entry of value) out.push(scrubValue(entry, seen));
    return out;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, entry] of Object.entries(value)) out[key] = scrubValue(entry, seen);
  return out;
}

/**
 * Exception messages browsers raise about their own layout work. Chrome fires
 * them on `window.onerror` when a `ResizeObserver` callback triggers another
 * layout pass, which is a warning about the page's own rendering, not a defect
 * the app can act on; they are the bulk of the exception corpus and would
 * drown the failures that matter.
 *
 * Exact messages, not a pattern over `ResizeObserver`: a real error whose text
 * merely mentions the API (a callback that threw, say) is a different event.
 */
const LAYOUT_WARNING_MESSAGES: Record<string, true> = {
  "ResizeObserver loop completed with undelivered notifications.": true,
  "ResizeObserver loop limit exceeded": true,
};

/**
 * The text an exception payload carries: its `value`, or the `message` when a
 * push arrived without one.
 */
function exceptionText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value: unknown = Reflect.get(payload, "value");
  if (typeof value === "string" && value !== "") return value;
  const message: unknown = Reflect.get(payload, "message");
  return typeof message === "string" ? message : undefined;
}

/**
 * Scrub a Faro transport item's payload — log messages, exception values and
 * stack frames, and log context — leaving `meta` (page URL, browser, session)
 * alone, since that is first-party data the dashboards read.
 *
 * Returns `null` for a browser layout warning ({@link LAYOUT_WARNING_MESSAGES}),
 * which drops the item: `beforeSend` treats `null` as "do not send", so the
 * filter lives at this single transport boundary rather than at a call site.
 *
 * Declared structurally and generically so this module stays free of the
 * telemetry SDK: only string leaves are rewritten, so each field keeps the
 * type it arrived with.
 */
export function scrubTelemetryItem<T extends { type: string; payload: unknown }>(
  item: T,
): T | null {
  if (item.type === "exception") {
    const text = exceptionText(item.payload);
    if (text !== undefined && Object.hasOwn(LAYOUT_WARNING_MESSAGES, text)) return null;
  }
  return { ...item, payload: scrubValue(item.payload) as T["payload"] };
}

/**
 * The telemetry user id for a DID: lower-case hex SHA-256 of
 * `` `${salt}:${did}` ``.
 *
 * A stored DID is a durable, cross-service identifier, so a log store that
 * carried it would hold far more than the product analytics it exists for, and
 * anything later joined against it inherits that reach. Hashing the DID keeps
 * the id stable for one (deployment, user) pair while the raw identifier never
 * leaves the device.
 *
 * The construction is fixed — separator, argument order, digest encoding —
 * so any other surface that needs to name the same user derives the identical
 * string.
 *
 * `undefined` means "no id", not a built-in default. A constant that ships in
 * every bundle separates nothing: every deployment that left the default unset
 * would mint ids from the same predictable space, re-identifying the same user
 * across unrelated instances. With no salt, then, the session stays anonymous.
 *
 * Async because `crypto.subtle.digest` is. `crypto` is a global in the
 * browser, in Node 22, and in the Tauri webview, so no import is needed.
 */
export async function pseudonymiseDid(
  did: string,
  salt: string | undefined,
): Promise<string | undefined> {
  if (!did || !salt) return undefined;
  const bytes = new TextEncoder().encode(`${salt}:${did}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
