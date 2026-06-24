/**
 * FileProfileResolver: in-memory mock of ProfileResolver for tests.
 *
 * Returns canned profiles and records which DIDs were looked up.
 */

import type { ProfileInfo, ProfileResolver } from "./profile-resolver.ts";

export class FileProfileResolver implements ProfileResolver {
	#profiles = new Map<string, ProfileInfo>();
	#lookups: string[] = [];

	constructor(profiles?: Record<string, ProfileInfo>) {
		if (profiles) {
			for (const [did, info] of Object.entries(profiles)) {
				this.#profiles.set(did, info);
			}
		}
	}

	async getProfile(did: string): Promise<ProfileInfo | undefined> {
		this.#lookups.push(did);
		return this.#profiles.get(did);
	}

	/** Set a canned profile for a DID. */
	setProfile(did: string, info: ProfileInfo): void {
		this.#profiles.set(did, info);
	}

	// ── Test helpers ────────────────────────────────────────────

	get lookups(): readonly string[] {
		return this.#lookups;
	}

	reset(): void {
		this.#profiles.clear();
		this.#lookups = [];
	}
}
