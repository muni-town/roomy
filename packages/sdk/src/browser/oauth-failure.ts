/**
 * Name the step an OAuth sign-in failed at, and carry the error body the
 * failing server returned.
 *
 * Every sign-in failure reaches the caller as one Error subclass whose message
 * is the inner error's message: `OAuthCallbackError.from` copies the message
 * off the original error and keeps that error as `cause`, so a caller that
 * prints the wrapper sees `Failed to register session: 400 …` and nothing
 * about where in the flow it happened. The status and the response body stay
 * on the cause — and the body is what identifies the offending scope token
 * when a server rejects the whole scope set.
 *
 * The classification is by error name and message because both client
 * libraries (`@happyview/oauth-client` and `@atproto/oauth-client`) throw
 * plain `Error` subclasses with no step field. It reads structurally, so it
 * works on either library's errors and on a rethrown copy.
 */

/** Where in the authorization flow the failure happened. */
export type OAuthStep =
  /** The authorization server redirected back with `error=`/`error_description`. */
  | "authorization"
  /** The callback parameters were unusable: no state, unknown state, no code. */
  | "callback"
  /** Handle/DID resolution, PDS or authorization-server metadata discovery. */
  | "resolution"
  /** The pushed authorization request (PAR) was refused. */
  | "pushed authorization request"
  /** The authorization code could not be exchanged for tokens at the PDS. */
  | "token exchange"
  /** A `private_key_jwt` client assertion could not be minted for the PDS. */
  | "client assertion"
  /** The DPoP key the flow binds its tokens to could not be provisioned. */
  | "dpop provisioning"
  /** The issued tokens were rejected when the session was registered. */
  | "session registration"
  /** No step matched; the summary still carries the message and body. */
  | "unknown";

export interface OAuthFailure {
  step: OAuthStep;
  /** One line for the sign-in screen and the log store. */
  summary: string;
  /** HTTP status of the request that failed, when the error carries one. */
  status?: number;
  /** That request's error body, JSON-parsed when it is JSON, else raw text. */
  body?: unknown;
  /** What the authorization server said when it refused at the consent step. */
  authorizationError?: { error: string; description?: string };
}

/** The slice of an Error this module reads; both libraries' errors fit it. */
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  body?: unknown;
  params?: unknown;
  cause?: unknown;
}

/**
 * Every error in the `cause` chain, outermost first.
 *
 * The chain is walked rather than read one level deep because each library
 * wraps the useful error exactly once: the callback wrapper holds the message,
 * its cause holds the status and body.
 */
function errorChain(err: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const link = current as ErrorLike;
    chain.push(link);
    current = link.cause;
  }
  return chain;
}

/**
 * The step an individual error names, or `null` when it says nothing about
 * the flow. Name first (the error classes are fixed), then message — the
 * HappyView endpoints' `ApiError`s all share one class, so only the message
 * distinguishes registering a session from minting an assertion.
 */
function stepFor(error: ErrorLike): OAuthStep | null {
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : "";

  if (name === "TokenExchangeError") return "token exchange";
  if (name === "InvalidStateError") return "callback";
  if (name === "ResolutionError") {
    return /PAR request failed/i.test(message)
      ? "pushed authorization request"
      : "resolution";
  }
  if (/register session/i.test(message)) return "session registration";
  if (/mint client assertion/i.test(message)) return "client assertion";
  if (/provision DPoP key/i.test(message)) return "dpop provisioning";
  if (/Unknown authorization session|Missing "state"|Missing "code"/i.test(message)) {
    return "callback";
  }
  return null;
}

/**
 * The `error`/`error_description` the authorization server put on the
 * callback. This is the one failure mode where the server names its own
 * reason before any token exists, e.g. `invalid_scope` because a requested
 * token is missing from the client metadata.
 */
function authorizationErrorOf(
  chain: ErrorLike[],
): OAuthFailure["authorizationError"] {
  for (const error of chain) {
    const params = error.params;
    if (!(params instanceof URLSearchParams) || !params.has("error")) continue;
    const code = params.get("error") ?? "unknown";
    const description = params.get("error_description");
    return description ? { error: code, description } : { error: code };
  }
  return undefined;
}

/** A response body as text: JSON re-serialized so it is one line, else as-is. */
function formatBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed === "") return "";
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(body) ?? "";
  } catch {
    return String(body);
  }
}

/**
 * Describe an OAuth failure as a named step plus the body of the request that
 * failed, in one line.
 */
export function describeOAuthFailure(err: unknown): OAuthFailure {
  const chain = errorChain(err);
  const authorizationError = authorizationErrorOf(chain);

  // Deepest first: the innermost error is the one the failing request threw,
  // and the wrappers above it only copy the message.
  const innermost = [...chain].reverse();
  const withStatus = innermost.find((e) => typeof e.status === "number");
  const withBody = innermost.find((e) => e.body !== undefined);
  const message =
    innermost
      .map((e) => (typeof e.message === "string" ? e.message : ""))
      .find((m) => m !== "") ?? String(err ?? "sign-in failed");

  const step: OAuthStep =
    authorizationError !== undefined
      ? "authorization"
      : (chain.map(stepFor).find((s): s is OAuthStep => s !== null) ?? "unknown");

  const status =
    withStatus && typeof withStatus.status === "number" ? withStatus.status : undefined;
  const body = withBody?.body;
  const bodyText = formatBody(body);

  let summary = `OAuth sign-in failed at ${step}`;
  if (status !== undefined) summary += ` (HTTP ${status})`;
  if (authorizationError) {
    summary += `: ${authorizationError.error}`;
    if (authorizationError.description) summary += ` — ${authorizationError.description}`;
  } else {
    summary += `: ${message}`;
  }
  if (bodyText !== "" && !summary.includes(bodyText)) {
    summary += `; error body: ${bodyText}`;
  }

  return { step, summary, status, body, authorizationError };
}
