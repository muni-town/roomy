/**
 * Unit tests for profile-sync.ts
 *
 * Covers: PS01–PS11 — new profile, unchanged, changed, retry queue,
 * avatar URLs, fan-out.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { UserDid } from "@roomy-space/sdk";
import { BridgeRepository } from "../../db/repository.ts";
import { MockRoomyGateway } from "../../roomy/mock-gateway.ts";
import { computeProfileHash } from "../../utils/hash.ts";
import { retryStaleProfileSyncs, syncUserProfile } from "../profile-sync.ts";
import { makeUser, SPACE_A, SPACE_B, USER_ID } from "./helpers/test-data.ts";
import { expectToBe } from "./utils.ts";

function profileEvent(roomy: MockRoomyGateway, spaceDid: string) {
	return roomy.findEvent(spaceDid, "space.roomy.user.updateProfile.v0");
}

function setupRepo(): BridgeRepository {
	return BridgeRepository.open(":memory:");
}

const DEFAULT_USER = makeUser();

describe("syncUserProfile", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// PS01: New profile (no hash)
	test("PS01: sends updateProfile for new user", async () => {
		await syncUserProfile(DEFAULT_USER, [SPACE_A], repo, roomy);

		const event = profileEvent(roomy, SPACE_A);
		expect(event).toBeDefined();
		expectToBe(event?.$type, "space.roomy.user.updateProfile.v0");
		expect(event.did).toBe(UserDid.assert(`did:discord:${USER_ID}`));
		expect(event.name).toBe(DEFAULT_USER.globalName);

		// Hash stored
		const hash = computeProfileHash(
			DEFAULT_USER.name,
			DEFAULT_USER.globalName ?? null,
			DEFAULT_USER.avatar ?? null,
		);
		expect(repo.getProfileHash(SPACE_A, USER_ID)).toBe(hash);
	});

	// PS02: Unchanged profile (hash matches)
	test("PS02: skips sync when hash matches existing", async () => {
		const hash = computeProfileHash(
			DEFAULT_USER.name,
			DEFAULT_USER.globalName ?? null,
			DEFAULT_USER.avatar ?? null,
		);
		repo.setProfileHash(SPACE_A, USER_ID, hash);

		await syncUserProfile(DEFAULT_USER, [SPACE_A], repo, roomy);

		expect(profileEvent(roomy, SPACE_A)).toBeUndefined();
	});

	// PS03: Changed profile (hash differs)
	test("PS03: sends updateProfile when hash differs", async () => {
		repo.setProfileHash(SPACE_A, USER_ID, "old-hash");

		await syncUserProfile(DEFAULT_USER, [SPACE_A], repo, roomy);

		const event = profileEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.user.updateProfile.v0");
		expect(event.name).toBe(DEFAULT_USER.globalName);

		// Hash updated
		const newHash = computeProfileHash(
			DEFAULT_USER.name,
			DEFAULT_USER.globalName ?? null,
			DEFAULT_USER.avatar ?? null,
		);
		expect(repo.getProfileHash(SPACE_A, USER_ID)).toBe(newHash);
	});

	// PS09: Default discriminator-based avatar
	test("PS09: generates discriminator-based avatar when no custom avatar", async () => {
		const userNoAvatar = makeUser({ avatar: null });

		await syncUserProfile(userNoAvatar, [SPACE_A], repo, roomy);

		const event = profileEvent(roomy, SPACE_A);
		expectToBe(event?.$type, "space.roomy.user.updateProfile.v0");
		expect(event.avatar).toContain("embed/avatars/");
	});

	// PS10: Fan-out to multiple spaces
	test("PS10: syncs profile to multiple bridged spaces", async () => {
		await syncUserProfile(DEFAULT_USER, [SPACE_A, SPACE_B], repo, roomy);

		expect(profileEvent(roomy, SPACE_A)).toBeDefined();
		expect(profileEvent(roomy, SPACE_B)).toBeDefined();

		const hash = computeProfileHash(
			DEFAULT_USER.name,
			DEFAULT_USER.globalName ?? null,
			DEFAULT_USER.avatar ?? null,
		);
		expect(repo.getProfileHash(SPACE_A, USER_ID)).toBe(hash);
		expect(repo.getProfileHash(SPACE_B, USER_ID)).toBe(hash);
	});
});

describe("retryStaleProfileSyncs", () => {
	let repo: BridgeRepository;
	let roomy: MockRoomyGateway;

	beforeEach(() => {
		repo = setupRepo();
		roomy = new MockRoomyGateway();
	});

	// PS05: Successful retry clears queue entry
	test("PS05: successful retry clears the queue entry", async () => {
		repo.__only_use_in_tests__db
			.prepare(
				`INSERT INTO profile_sync_queue (space_did, discord_user_id, username, global_name, avatar_hash, discriminator, retry_count, next_retry_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
			)
			.run(SPACE_A, USER_ID, "testuser", "Test User", null, "1234");

		const stale = repo.getStaleProfileSyncEntries();
		expect(stale.length).toBe(1);

		await retryStaleProfileSyncs(repo, roomy);

		const remaining = repo.getStaleProfileSyncEntries();
		expect(remaining.length).toBe(0);

		const hash = computeProfileHash("testuser", "Test User", null);
		expect(repo.getProfileHash(SPACE_A, USER_ID)).toBe(hash);
	});

	// PS06: Retry sweep skips if hash already matches
	test("PS06: skips retry when hash already matches", async () => {
		const hash = computeProfileHash("testuser", "Test User", null);
		repo.setProfileHash(SPACE_A, USER_ID, hash);
		repo.enqueueProfileSync(
			SPACE_A,
			USER_ID,
			"testuser",
			"Test User",
			null,
			"1234",
		);

		await retryStaleProfileSyncs(repo, roomy);

		const remaining = repo.getStaleProfileSyncEntries();
		expect(remaining.length).toBe(0);
		expect(profileEvent(roomy, SPACE_A)).toBeUndefined();
	});

	test("does nothing when queue is empty", async () => {
		await retryStaleProfileSyncs(repo, roomy);
		expect(roomy.eventCount(SPACE_A)).toBe(0);
	});
});
