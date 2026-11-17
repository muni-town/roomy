/**
 * Reading the HTTP status out of a discordeno REST failure.
 *
 * discordeno swallows the response: every non-2xx is rethrown as
 * `Error("Failed to send request to discord.")` with the actual result
 * (`{ ok, status, body }` — or `{ ok, status, error }` for a failed
 * 429 budget / a network failure, status 999) attached as `error.cause`.
 * Without unwrapping it, the status code that discriminates a deterministic
 * failure (404 Unknown Message, 403 Missing Permissions) from a transient one
 * never reaches a decision or a log line.
 */

/** Type guard: the error carries a `.cause` property. */
function hasCause(error: unknown): error is { cause: unknown } {
	return typeof error === "object" && error !== null && "cause" in error;
}

/** Discord's machine-readable code from the response body (e.g. 10015
 *  Unknown Webhook), when the body carried one. */
function failureCode(cause: unknown): number | undefined {
	if (typeof cause !== "object" || cause === null || !("body" in cause)) {
		return undefined;
	}
	const { body } = cause;
	if (typeof body !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"code" in parsed &&
			typeof parsed.code === "number"
		) {
			return parsed.code;
		}
	} catch {
		// Not JSON — no code to read.
	}
	return undefined;
}

/** Pull the real HTTP status (and error body) out of a discordeno REST error. */
export function discordFailureDetail(err: unknown): {
	status: number | undefined;
	body: string | undefined;
	code: number | undefined;
} {
	if (!hasCause(err))
		return { status: undefined, body: undefined, code: undefined };
	const { cause } = err;
	if (typeof cause !== "object" || cause === null)
		return { status: undefined, body: undefined, code: undefined };
	if (!("status" in cause))
		return { status: undefined, body: undefined, code: undefined };
	const { status } = cause;
	if (typeof status !== "number")
		return { status: undefined, body: undefined, code: undefined };
	const body =
		"body" in cause && typeof cause.body === "string"
			? cause.body
			: "error" in cause && typeof cause.error === "string"
				? cause.error
				: undefined;
	return { status, body, code: failureCode(cause) };
}

/**
 * A short, stable name for what the failing status means, so a log line can
 * tell a rate limit apart from permission loss or a webhook that no longer
 * exists. `unknown` covers failures with no HTTP status (a timeout, a closed
 * socket) — those are retried, but the classification says the cause is not
 * a Discord answer.
 */
export type DiscordFailureClass =
	| "rate_limited"
	| "network"
	| "server_error"
	| "missing_permissions"
	| "unknown_webhook"
	| "not_found"
	| "invalid_request"
	| "client_error"
	| "unknown";

export function classifyDiscordFailure(
	status: number | undefined,
	code?: number,
): DiscordFailureClass {
	if (status === undefined) return "unknown";
	if (status === 429) return "rate_limited";
	if (status === 999) return "network";
	if (status >= 500) return "server_error";
	if (status === 403) return "missing_permissions";
	if (status === 404) return code === 10015 ? "unknown_webhook" : "not_found";
	if (status === 400 || status === 422) return "invalid_request";
	return "client_error";
}

/** Everything a caller needs to decide, log and store a Discord failure. */
export type DiscordFailure = {
	status: number | undefined;
	code: number | undefined;
	classification: DiscordFailureClass;
	retryable: boolean;
	/** The thrown error's own message (discordeno's generic one, usually). */
	message: string;
	/** Discord's response message, truncated, when the body carried one. */
	detail: string | undefined;
	/** `message` with the status and classification appended — durable text. */
	text: string;
};

export function describeDiscordFailure(err: unknown): DiscordFailure {
	const { status, code } = discordFailureDetail(err);
	const classification = classifyDiscordFailure(status, code);
	const message = err instanceof Error ? err.message : String(err);
	return {
		status,
		code,
		classification,
		retryable: isRetryableDiscordStatus(status),
		message,
		detail: discordFailureMessage(err),
		text: `${message} [Discord ${status ?? "no status"} ${classification}]`,
	};
}

/** Max chars of a Discord error body to keep in a durable blocked reason. */
const MAX_REASON_CHARS = 200;

/**
 * True when retrying can plausibly succeed: rate-limited (429), server-side
 * (5xx), and network-level (999 / unknown). A deterministic 4xx client error
 * is rejected before Discord executes the request — backoff cannot change the
 * outcome, so failing fast is strictly better than burning a retry budget on
 * a known-constant answer.
 */
export function isRetryableDiscordStatus(status: number | undefined): boolean {
	if (status === undefined) return true;
	return status === 429 || status === 999 || status >= 500;
}

/**
 * Why the bridge cannot read a channel, or null when the failure is transient
 * (worth retrying on a later run) or carries no HTTP status.
 *
 * Discord refuses the read deterministically in two ways:
 * `403 Missing Access` (code 50001) / `403 Missing Permissions` (50013) when
 * the bot lacks VIEW_CHANNEL or READ_MESSAGE_HISTORY, and `404 Unknown Channel`
 * (10003) once the channel has been deleted. Both are permanent for as long as
 * the mapping stands, so a backfill that records neither spins forever.
 */
export function channelReadDenial(
	err: unknown,
): "missing_access" | "unknown_channel" | null {
	const { status } = discordFailureDetail(err);
	if (status === 403) return "missing_access";
	if (status === 404) return "unknown_channel";
	return null;
}

/**
 * Why the bridge cannot read a channel at all, or null when the failure is
 * transient (worth retrying on a later run) or carries no HTTP status.
 *
 * The text is durable — it lands in `backfill_progress.blocked_reason` and is
 * what the status panel shows the operator — so it names the channel-read
 * failure rather than the caller that hit it.
 */
export function channelReadFailureReason(err: unknown): string | null {
	const denial = channelReadDenial(err);
	if (!denial) return null;
	const message = discordFailureMessage(err);
	const detail = message ? `: ${message}` : "";
	return denial === "missing_access"
		? `the bridge can't read this channel (Discord 403${detail})`
		: `this channel no longer exists in Discord (404${detail})`;
}

/**
 * Blocked reason for a channel the bridge cannot read when the failing status
 * is no longer available to name. `channelReadFailureReason` carries the exact
 * 403/404 text when the error is still in hand.
 */
export const CHANNEL_UNREADABLE_REASON = "the bridge can't read this channel";

/** Discord's own message for a failed read, truncated for durable storage. */
export function discordFailureMessage(err: unknown): string | undefined {
	const { body } = discordFailureDetail(err);
	if (!body) return undefined;
	let message = body;
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"message" in parsed &&
			typeof parsed.message === "string"
		) {
			message = parsed.message;
		}
	} catch {
		// Not JSON — the raw body is the best available description.
	}
	return message.length <= MAX_REASON_CHARS
		? message
		: `${message.slice(0, MAX_REASON_CHARS)}…`;
}
