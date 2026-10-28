/**
 * Verify the bridge's ATProto credentials before anything depends on them.
 *
 * A rejected app password fails the bridge on boot with an XRPC message that
 * names neither the account nor the PDS, which reads like a code fault. This
 * script performs the same login the bridge performs and prints the account
 * it resolved, so a wrong DID or a stale app password is a one-line error.
 *
 * Usage (from packages/discord-bridge, same env as the bridge):
 *   bun run src/scripts/check-credentials.ts
 */

import { AtpAgent } from "@atproto/api";
import {
	APPSERVER_DID,
	APPSERVER_URL,
	ATPROTO_BRIDGE_APP_PASSWORD,
	ATPROTO_BRIDGE_DID,
} from "../env.ts";
import {
	loginBridgeAccount,
	looksLikeAppPassword,
	resolveLoginService,
} from "../roomy/atproto-login.ts";

async function main(): Promise<void> {
	const identifier = ATPROTO_BRIDGE_DID();
	const password = ATPROTO_BRIDGE_APP_PASSWORD();

	console.log(`bridge account: ${identifier}`);
	console.log(`appserver:      ${APPSERVER_URL()} (${APPSERVER_DID()})`);
	if (!looksLikeAppPassword(password.trim())) {
		console.warn(
			"warning: ATPROTO_BRIDGE_APP_PASSWORD is not shaped like a Bluesky app password (xxxx-xxxx-xxxx-xxxx)",
		);
	}
	const service = await resolveLoginService(identifier);
	const agent = new AtpAgent({ service });
	await loginBridgeAccount(agent, identifier, password);

	console.log(`  did:    ${agent.did}`);
	console.log(`  handle: ${agent.session?.handle ?? "(unknown)"}`);
	console.log(`  pds:    ${service}`);
}

try {
	await main();
} catch (err) {
	console.error(`\n${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
