/**
 * LiveProfileResolver: resolves ATProto DIDs to profiles via the
 * RoomyClient, with an in-memory LRU cache.
 */

import { Did, type RoomyClient } from "@roomy-space/sdk";
import { createLogger } from "../logger.ts";
import type { ProfileInfo, ProfileResolver } from "./profile-resolver.ts";

const log = createLogger("live-profile");

const CACHE_MAX = 500;

/**
 * Hard deadline for a single profile lookup against api.bsky.app.
 *
 * Profile resolution runs on the Roomy→Discord delivery hot path: each
 * frame is awaited sequentially per space, and `Agent.getProfile` issues an
 * unauthenticated fetch to the public Bluesky appview with no built-in
 * timeout. A hung or slow connection (e.g. an idle socket reaped by an
 * intermediary after ~15 min) blocks the entire per-space processing
 * chain until it resolves. Capping the wait keeps a single slow lookup
 * from stalling message delivery for the whole space. On timeout we fall
 * back to the default username/avatar so the message still ships.
 */
const PROFILE_FETCH_TIMEOUT_MS = 5000;

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
			const profile = await this.#client.getProfile(
				Did.assert(did),
				AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
			);
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
			if (err instanceof DOMException && err.name === "TimeoutError") {
				log.warn(
					`Profile fetch for ${did} timed out after ${PROFILE_FETCH_TIMEOUT_MS}ms; using default identity`,
				);
			} else {
				log.warn(`Failed to resolve profile for ${did}`, err);
			}
			return undefined;
		}
	}
}
