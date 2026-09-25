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
