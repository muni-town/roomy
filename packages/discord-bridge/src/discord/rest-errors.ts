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

/** Pull the real HTTP status (and error body) out of a discordeno REST error. */
export function discordFailureDetail(err: unknown): {
	status: number | undefined;
	body: string | undefined;
} {
	if (!hasCause(err)) return { status: undefined, body: undefined };
	const { cause } = err;
	if (typeof cause !== "object" || cause === null)
		return { status: undefined, body: undefined };
	if (!("status" in cause)) return { status: undefined, body: undefined };
	const { status } = cause;
	if (typeof status !== "number") return { status: undefined, body: undefined };
	const body =
		"body" in cause && typeof cause.body === "string"
			? cause.body
			: "error" in cause && typeof cause.error === "string"
				? cause.error
				: undefined;
	return { status, body };
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
