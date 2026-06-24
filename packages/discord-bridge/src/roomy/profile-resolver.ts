/**
 * ProfileResolver: resolves ATProto DIDs to display names and avatars
 * for use when forwarding Roomy messages to Discord.
 */

export interface ProfileInfo {
	name: string;
	handle: string | null;
	avatarUrl: string | null;
}

export interface ProfileResolver {
	/** Resolve a Roomy user's profile. Returns undefined for unknown DIDs. */
	getProfile(did: string): Promise<ProfileInfo | undefined>;
}
