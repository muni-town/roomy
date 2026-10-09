/**
 * Redaction of absolute URLs from telemetry payloads.
 *
 * Third-party clients put whole request URLs into error messages —
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
 * Scrub a Faro transport item's payload — log messages, exception values and
 * stack frames, and log context — leaving `meta` (page URL, browser, session)
 * alone, since that is first-party data the dashboards read.
 *
 * Declared structurally and generically so this module stays free of the
 * telemetry SDK: only string leaves are rewritten, so each field keeps the
 * type it arrived with.
 */
export function scrubTelemetryItem<T extends { payload: unknown }>(item: T): T {
  return { ...item, payload: scrubValue(item.payload) as T["payload"] };
}
