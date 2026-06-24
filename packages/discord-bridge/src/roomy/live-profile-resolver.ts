/**
 * LiveProfileResolver: resolves ATProto DIDs to profiles via the
 * RoomyClient, with an in-memory LRU cache.
 */

import { Did, type RoomyClient } from "@roomy-space/sdk";
import { createLogger } from "../logger.ts";
import type { ProfileInfo, ProfileResolver } from "./profile-resolver.ts";

const log = createLogger("live-profile");

const CACHE_MAX = 500;

export class LiveProfileResolver implements ProfileResolver {
	#client: RoomyClient;
	#cache = new Map<string, ProfileInfo>();

	constructor(client: RoomyClient) {
		this.#client = client;
	}

	async getProfile(did: string): Promise<ProfileInfo | undefined> {
		// Check cache first
		const cached = this.#cache.get(did);
		if (cached) {
			// Move to the end so recently accessed entries survive eviction.
			this.#cache.delete(did);
			this.#cache.set(did, cached);
			return cached;
		}

		try {
			const profile = await this.#client.getProfile(Did.assert(did));
			if (!profile) return undefined;

			const info: ProfileInfo = {
				name: profile.displayName || profile.handle || did,
				handle: profile.handle ?? null,
				avatarUrl: profile.avatar ?? null,
			};

			// Enforce LRU eviction.
			if (this.#cache.size >= CACHE_MAX) {
				const oldestKey = this.#cache.keys().next().value;
				if (oldestKey) this.#cache.delete(oldestKey);
			}
			this.#cache.set(did, info);

			return info;
		} catch (err) {
			log.warn(`Failed to resolve profile for ${did}`, err);
			return undefined;
		}
	}
}
