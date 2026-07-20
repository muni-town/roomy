import type { Agent } from "@atproto/api";
import type { Did } from "../schema";

export interface Profile {
  id: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  banner?: string;
}

/** Fetch a profile from ATProto.
 *
 * Accepts an optional `AbortSignal` so callers on a delivery hot path
 * (e.g. the Discord bridge) can bound how long a single profile lookup
 * blocks progress. The signal is forwarded to `@atproto/api`'s
 * `Agent.getProfile`, which passes it through to the underlying fetch.
 * An aborted signal causes the fetch to reject immediately rather than
 * stall until an intermediary reaps an idle socket. */
export async function getProfile(
	agent: Agent,
	did?: Did,
	signal?: AbortSignal,
): Promise<Profile | undefined> {
	const targetDid = did || agent.did;
	if (!targetDid) throw new Error("No DID provided and agent has no DID");

	const resp = await agent.getProfile(
		{ actor: targetDid },
		{
			headers: {
				"atproto-proxy": `did:web:api.bsky.app#bsky_appview`,
			},
			signal,
		},
	);
	if (!resp.success) return undefined;

	return {
		id: resp.data.did,
		handle: resp.data.handle,
		displayName: resp.data.displayName,
		description: resp.data.description,
		avatar: resp.data.avatar,
		banner: resp.data.banner,
	};
}

/** Create a cached profile resolver. */
export function createProfileResolver(agent: Agent) {
	const cache = new Map<string, Profile | undefined>();

	return async (did: Did): Promise<Profile | undefined> => {
		const cached = cache.get(did);
		if (cached !== undefined) return cached;

		const profile = await getProfile(agent, did);
		cache.set(did, profile);
		return profile;
	};
}
