/**
 * ATProto login for the bridge account.
 *
 * `createSession` is served by the account's own PDS, so the agent is pointed
 * at the PDS named in the account's DID document rather than at a fixed host.
 * A handle identifier is left to `bsky.social`, which resolves it.
 *
 * A rejected password is the one failure an operator meets with no log line
 * that says what was tried, so a failed login is reported with the identifier
 * and the PDS it was sent to.
 */

import type { AtpPersistSessionHandler } from "@atproto/api";
import { transport } from "@roomy-space/sdk";
import { createLogger } from "../logger.ts";

const log = createLogger("roomy");

/** Fallback PDS, and the service that resolves a handle identifier. */
const DEFAULT_SERVICE = "https://bsky.social";

/** Bluesky app passwords are four groups of four characters. */
const APP_PASSWORD_SHAPE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;

/** The part of an agent a login needs, so tests can drive one without a server. */
export type LoginTarget = {
	login(credentials: {
		identifier: string;
		password: string;
	}): Promise<unknown>;
	readonly did: string | undefined;
	readonly session: { handle?: string } | undefined;
	readonly serviceUrl?: URL;
};

export type LoginOptions = {
	persistSession?: AtpPersistSessionHandler;
	/** DID → PDS endpoint. Injectable for tests. */
	resolvePds?: (did: string) => Promise<string>;
};

export function looksLikeAppPassword(value: string): boolean {
	return APP_PASSWORD_SHAPE.test(value);
}

/**
 * The PDS that serves `createSession` for `identifier`.
 *
 * A DID resolves through its DID document. Resolution failure falls back to
 * `bsky.social` with a warning: that is correct for an account there, and the
 * login error names the service either way.
 */
export async function resolveLoginService(
	identifier: string,
	resolvePds: (did: string) => Promise<string> = transport.resolvePdsEndpoint,
): Promise<string> {
	if (!identifier.startsWith("did:")) return DEFAULT_SERVICE;
	try {
		return await resolvePds(identifier);
	} catch (err) {
		log.warn(
			`Could not resolve the PDS for ${identifier}; logging in at ${DEFAULT_SERVICE}`,
			err,
		);
		return DEFAULT_SERVICE;
	}
}

function loginFailureMessage(
	identifier: string,
	service: string,
	password: string,
	err: unknown,
): string {
	const reason = err instanceof Error ? err.message : String(err);
	const lines = [
		`ATProto login rejected for ${identifier} at ${service}: ${reason}`,
	];
	if (!looksLikeAppPassword(password)) {
		lines.push(
			"The password is not shaped like a Bluesky app password (xxxx-xxxx-xxxx-xxxx).",
		);
	}
	lines.push(
		"ATPROTO_BRIDGE_DID must name the bridge account, and ATPROTO_BRIDGE_APP_PASSWORD must be an app password created on that account. Surrounding whitespace and quotes are part of the value and are rejected.",
	);
	return lines.join("\n");
}

/**
 * Login `agent` as the bridge account.
 *
 * Both values are trimmed: a secret stored with a trailing newline or a pair
 * of quotes is a common misconfiguration and never a real credential.
 */
export async function loginBridgeAccount(
	agent: LoginTarget,
	identifierInput: string,
	passwordInput: string,
): Promise<void> {
	const identifier = identifierInput.trim();
	const password = passwordInput.trim();
	const service = agent.serviceUrl?.origin ?? "the account's PDS";
	try {
		await agent.login({ identifier, password });
	} catch (err) {
		throw new Error(loginFailureMessage(identifier, service, password, err), {
			cause: err,
		});
	}
	log.info(
		`Authenticated as ${agent.did} (${agent.session?.handle ?? "no handle"}) at ${service}`,
	);
}
